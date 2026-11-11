import { Router } from 'express';
import { z } from 'zod';

import { PROVIDERS, resolveProvider, pacingDefaults, buildWarmupSchedule } from '../config/providers.js';
import {
  allMailboxes, getMailbox, toPublicMailbox, createMailbox, updateMailbox,
  recordVerification, campaignsUsingMailbox, removeMailbox, domainDailyLoad,
  mailboxSecrets,
} from '../db/repositories/mailboxes.js';
import { getSettings } from '../db/repositories/settings.js';
import { logAction } from '../db/repositories/users.js';
import { checkDomain } from '../lib/dns-check.js';
import { connectionTargetFor } from '../lib/resolve-host.js';
import { recordDomainHealth } from '../db/repositories/domain-health.js';
import { seal } from '../lib/secret-box.js';
import { checkAchievable, checkProviderCeiling } from '../lib/pacing-check.js';
import { getTransport, verifyTransport, markTransportStale } from '../mail/transport.js';
import { composeMessage } from '../mail/compose.js';
import { warmupStage } from '../lib/warmup.js';
import { requireAuth, requireAdmin, validate } from '../middleware/index.js';

export const mailboxesRouter = Router();
mailboxesRouter.use(requireAuth);

/**
 * Mailboxes: the sending accounts, configured here rather than in .env.
 *
 * Reading is open to any signed-in user, because the campaign wizard needs
 * the list to populate its sender picker. Every write is admin-only, since a
 * mailbox carries a credential and sets the pacing that protects the domain.
 *
 * No response from this router ever contains a password, sealed or otherwise:
 * everything goes out through `toPublicMailbox`.
 */

const passwordField = z.string().min(1).max(500).optional();

const mailboxSchema = z.object({
  label: z.string().trim().min(1).max(200),
  provider: z.enum(['google', 'zoho', 'other']).default('other'),
  region: z.string().trim().max(20).nullable().optional(),

  fromName: z.string().trim().max(120).default(''),
  fromEmail: z.string().trim().email(),
  replyTo: z.string().trim().email().or(z.literal('')).default(''),
  sendingDomain: z.string().trim().max(253).optional(),
  dkimSelector: z.string().trim().max(63).optional(),

  smtpHost: z.string().trim().max(253).optional(),
  smtpPort: z.coerce.number().int().positive().max(65535).optional(),
  smtpUser: z.string().trim().max(320).optional(),
  smtpPassword: passwordField,

  imapEnabled: z.boolean().default(false),
  imapHost: z.string().trim().max(253).optional(),
  imapPort: z.coerce.number().int().positive().max(65535).optional(),
  imapUser: z.string().trim().max(320).optional(),
  imapPassword: passwordField,
  imapPollSeconds: z.coerce.number().int().min(30).max(3600).optional(),

  dailyCap: z.coerce.number().int().min(1).max(5000).nullable().optional(),
  hourlyCap: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  minIntervalSeconds: z.coerce.number().int().min(1).max(3600).nullable().optional(),
  jitterPercent: z.coerce.number().int().min(0).max(100).optional(),
  warmupEnabled: z.boolean().optional(),
  warmupStartedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),

  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** Everything optional, so a PATCH can carry one field. */
const mailboxPatchSchema = mailboxSchema.partial();

function domainOf(email) {
  return String(email).split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Turns a TLS failure into something the operator can act on.
 *
 * A certificate error against a major provider is almost never the provider.
 * It is local security software terminating the TLS session to scan it -
 * antivirus mail protection does this to IMAP in particular, and often
 * leaves SMTP alone, which produces the confusing "SMTP OK, IMAP failed"
 * result. The provider's real certificate is fine; the one this process was
 * handed is not the provider's.
 *
 * Worth saying out loud rather than leaving as a bare OpenSSL code, because
 * the tempting "fix" is to stop verifying certificates, which would hand
 * every mailbox password to whatever is in the middle.
 */
function tlsHint(error) {
  const code = error?.code ?? '';
  const text = String(error?.message ?? '');

  if (/SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|self-signed certificate/i.test(`${code} ${text}`)) {
    return 'The certificate presented was not the provider\'s. This is usually antivirus or '
      + 'a corporate proxy intercepting the connection on this machine - check its mail or '
      + 'encrypted-connection scanning, and exclude this application. A server without that '
      + 'software in the way is unaffected.';
  }
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/i.test(code)) {
    return 'The certificate chain could not be verified, which usually means something is '
      + 'rewriting TLS between this machine and the provider.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) {
    return 'The host could not be resolved. Check the IMAP host for this provider.';
  }
  if (/ETIMEDOUT|ECONNREFUSED/i.test(code)) {
    return 'Nothing answered on that port. A firewall may be blocking outbound IMAP.';
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(text)) {
    return 'The server rejected the credentials. IMAP needs an app-specific password too, '
      + 'and it has to be generated while signed in as this mailbox.';
  }
  return null;
}

/**
 * Fills in whatever the form left blank from the provider preset, so adding a
 * Zoho or Google mailbox needs an address and a password and nothing else.
 */
function applyPreset(body, existing = null) {
  const provider = body.provider ?? existing?.provider ?? 'other';
  const smtpHost = body.smtpHost ?? existing?.smtp_host ?? '';
  const preset = resolveProvider(provider, smtpHost || PROVIDERS[provider]?.smtpHost || '');

  const fromEmail = body.fromEmail ?? existing?.from_email;
  const regional = provider === 'zoho' && body.region && PROVIDERS.zoho.regions?.[body.region]
    ? PROVIDERS.zoho.regionHosts(body.region)
    : null;

  return {
    preset,
    values: {
      smtp_host: body.smtpHost || regional?.smtpHost || preset.smtpHost || existing?.smtp_host || '',
      smtp_port: body.smtpPort ?? existing?.smtp_port ?? preset.smtpPort ?? 465,
      // Defaults to the From address, which is what every provider expects
      // and what Gmail in particular requires.
      smtp_user: body.smtpUser || existing?.smtp_user || fromEmail,
      sending_domain: body.sendingDomain || existing?.sending_domain || domainOf(fromEmail),
      dkim_selector: body.dkimSelector || existing?.dkim_selector || preset.dkimSelector || 'default',
      imap_host: body.imapHost || regional?.imapHost || preset.imapHost || existing?.imap_host || '',
      imap_port: body.imapPort ?? existing?.imap_port ?? preset.imapPort ?? 993,
      imap_user: body.imapUser || existing?.imap_user || fromEmail,
    },
  };
}

/**
 * The checks that stop a mailbox being saved into a state that fails silently
 * at send time rather than loudly here.
 */
function validateMailbox({ preset, values, body, existing }) {
  const fromEmail = body.fromEmail ?? existing?.from_email;

  // Gmail rewrites any From other than the authenticated mailbox or a
  // verified alias. The rewrite breaks DKIM alignment, so DMARC fails and the
  // whole campaign lands in spam - with no error at any point.
  if (preset.fromMustMatchUser && values.smtp_user.toLowerCase() !== String(fromEmail).toLowerCase()) {
    return {
      error: `${preset.label} only sends as the authenticated mailbox. `
        + `The SMTP username (${values.smtp_user}) and the From address (${fromEmail}) must match, `
        + 'unless the From address is a verified "Send mail as" alias.',
    };
  }

  const imapEnabled = body.imapEnabled ?? existing?.imap_enabled ?? false;
  const willHaveImapPassword = body.imapPassword || existing?.imap_password_cipher;
  if (imapEnabled && (!values.imap_host || !values.imap_user || !willHaveImapPassword)) {
    return { error: 'IMAP needs a host, a username and a password, or it has to be turned off.' };
  }

  // Pacing: the ceiling the provider allows, then whether the numbers can
  // actually deliver inside the global sending window.
  const defaults = pacingDefaults(preset);
  const effective = {
    dailyCap: body.dailyCap ?? existing?.daily_cap ?? defaults.dailyCap,
    hourlyCap: body.hourlyCap ?? existing?.hourly_cap ?? defaults.hourlyCap,
    minIntervalSeconds:
      body.minIntervalSeconds ?? existing?.min_interval_seconds ?? defaults.minIntervalSeconds,
  };

  const ceiling = checkProviderCeiling(effective.dailyCap, preset);
  if (!ceiling.ok) return ceiling;

  const settings = getSettings();
  const reach = checkAchievable({
    ...effective,
    windowHours: settings.sendWindowEndHour - settings.sendWindowStartHour,
  });
  if (!reach.ok) return reach;

  return null;
}

/** Shape sent to the client: never a credential, always the derived numbers. */
function present(mailbox) {
  return {
    ...toPublicMailbox(mailbox),
    pacing: mailbox.pacing,
    warmup: warmupStage(mailbox.pacing),
    providerLabel: mailbox.preset.label,
    bulkPolicyNote: mailbox.preset.bulkPolicyNote,
    appPasswordUrl: mailbox.preset.appPasswordUrl,
  };
}

mailboxesRouter.get('/', (_req, res) => {
  res.json({
    mailboxes: allMailboxes().map(present),
    // Several mailboxes on one domain all spend the same domain's reputation.
    // Four at 300/day is 1,200/day from a cold domain, which is exactly what
    // warm-up exists to prevent and what nothing else here would notice.
    domainLoad: domainDailyLoad(),
  });
});

/** Presets, so the form can fill in hosts and ports once a provider is picked. */
mailboxesRouter.get('/providers', (_req, res) => {
  res.json({
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      smtpHost: p.smtpHost,
      smtpPort: p.smtpPort,
      imapHost: p.imapHost,
      imapPort: p.imapPort,
      dkimSelector: p.dkimSelector,
      appPasswordUrl: p.appPasswordUrl,
      recommendedDailyCap: p.recommendedDailyCap,
      dailyLimit: p.dailyLimit,
      dailyLimitNote: p.dailyLimitNote,
      bulkPolicyNote: p.bulkPolicyNote,
      fromMustMatchUser: p.fromMustMatchUser,
      regions: p.regions ?? null,
    })),
  });
});

mailboxesRouter.post('/', requireAdmin, validate(mailboxSchema), async (req, res, next) => {
  try {
    const body = req.body;
    if (!body.smtpPassword) {
      return res.status(400).json({ error: 'An SMTP password is required' });
    }

    const { preset, values } = applyPreset(body);
    const invalid = validateMailbox({ preset, values, body, existing: null });
    if (invalid) return res.status(400).json(invalid);

    if (!values.smtp_host) {
      return res.status(400).json({ error: 'An SMTP host is required for this provider' });
    }

    const defaults = pacingDefaults(preset);

    const mailbox = await createMailbox({
      label: body.label,
      provider: body.provider,
      region: body.region ?? preset.region ?? null,
      from_name: body.fromName,
      from_email: body.fromEmail,
      reply_to: body.replyTo,
      ...values,
      smtp_password_cipher: seal(body.smtpPassword),
      imap_enabled: body.imapEnabled,
      imap_password_cipher: body.imapPassword ? seal(body.imapPassword) : null,
      imap_poll_seconds: body.imapPollSeconds ?? 120,
      daily_cap: body.dailyCap ?? null,
      hourly_cap: body.hourlyCap ?? null,
      min_interval_seconds: body.minIntervalSeconds ?? null,
      jitter_percent: body.jitterPercent ?? 60,
      warmup_enabled: body.warmupEnabled ?? true,
      warmup_started_on: body.warmupStartedOn ?? null,
      // Frozen at creation, not re-derived: the ramp is anchored to its start
      // date, so a later change to the preset must not step the volume up.
      warmup_schedule: JSON.stringify(
        buildWarmupSchedule(body.dailyCap ?? defaults.dailyCap),
      ),
      is_active: body.isActive ?? true,
      is_default: body.isDefault ?? allMailboxes().length === 0,
    }, req.user.id);

    // Never the body - it holds the password.
    await logAction({
      userId: req.user.id,
      action: 'mailbox.create',
      entity: 'mailbox',
      entityId: mailbox.id,
      detail: { label: mailbox.label, from: mailbox.from_email, provider: mailbox.provider },
    });

    res.status(201).json({ mailbox: present(mailbox) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A mailbox with that name or address already exists' });
    }
    next(error);
  }
});

mailboxesRouter.patch('/:id', requireAdmin, validate(mailboxPatchSchema), async (req, res, next) => {
  try {
    const existing = getMailbox(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Mailbox not found' });

    const body = req.body;
    const { preset, values } = applyPreset(body, existing);
    const invalid = validateMailbox({ preset, values, body, existing });
    if (invalid) return res.status(400).json(invalid);

    const patch = { ...values };
    const set = (key, value) => { if (value !== undefined) patch[key] = value; };

    set('label', body.label);
    set('provider', body.provider);
    set('region', body.region);
    set('from_name', body.fromName);
    set('from_email', body.fromEmail);
    set('reply_to', body.replyTo);
    set('imap_enabled', body.imapEnabled);
    set('imap_poll_seconds', body.imapPollSeconds);
    set('daily_cap', body.dailyCap);
    set('hourly_cap', body.hourlyCap);
    set('min_interval_seconds', body.minIntervalSeconds);
    set('jitter_percent', body.jitterPercent);
    set('warmup_enabled', body.warmupEnabled);
    set('warmup_started_on', body.warmupStartedOn);
    set('is_active', body.isActive);
    set('is_default', body.isDefault);

    // A blank password field means "leave it alone". Writing the empty string
    // through would lock the mailbox out on the next send.
    if (body.smtpPassword) patch.smtp_password_cipher = seal(body.smtpPassword);
    if (body.imapPassword) patch.imap_password_cipher = seal(body.imapPassword);

    const mailbox = await updateMailbox(existing.id, patch);

    // Credentials may have changed, so the pooled connection is dropped. Not
    // closed: a message could be on the wire. The owning loop picks up the
    // new config_version on its next tick.
    markTransportStale(existing.id);

    await logAction({
      userId: req.user.id,
      action: 'mailbox.update',
      entity: 'mailbox',
      entityId: mailbox.id,
      // Field names only. The body holds credentials.
      detail: { fields: Object.keys(patch) },
    });

    res.json({ mailbox: present(mailbox) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A mailbox with that name or address already exists' });
    }
    next(error);
  }
});

/** SMTP login plus the DNS the mailbox's own domain and selector need. */
mailboxesRouter.post('/:id/verify', requireAdmin, async (req, res, next) => {
  try {
    const mailbox = getMailbox(req.params.id);
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

    const result = { smtp: { ok: false }, imap: { ok: false, skipped: !mailbox.imap_enabled } };

    try {
      await verifyTransport(mailbox);
      result.smtp = { ok: true };
    } catch (error) {
      result.smtp = { ok: false, error: error.message, hint: tlsHint(error) };
    }

    if (mailbox.imap_enabled) {
      try {
        const { ImapFlow } = await import('imapflow');
        const { imapPassword } = await mailboxSecrets(mailbox.id);

        // Deliberately the same connection path the poller uses: the host is
        // pre-resolved and `servername` carries the real name for
        // certificate validation. A check that connected differently from
        // the worker could pass here and still fail every poll.
        const target = await connectionTargetFor(mailbox.imap_host);
        const client = new ImapFlow({
          host: target.host,
          port: mailbox.imap_port,
          secure: true,
          auth: { user: mailbox.imap_user, pass: imapPassword },
          tls: {
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            servername: target.servername,
          },
          logger: false,
        });
        await client.connect();
        await client.logout();
        result.imap = { ok: true };
      } catch (error) {
        result.imap = { ok: false, error: error.message, hint: tlsHint(error) };
      }
    }

    // DNS is checked for this mailbox's own domain AND selector - two
    // mailboxes can share a domain and still need different answers.
    try {
      const dns = await checkDomain(mailbox.sending_domain, mailbox.dkim_selector, {
        provider: mailbox.preset,
      });
      await recordDomainHealth(mailbox.sending_domain, mailbox.dkim_selector, dns);
      result.dns = dns;
    } catch (error) {
      result.dns = { error: error.message };
    }

    await recordVerification(mailbox.id, {
      ok: result.smtp.ok,
      error: result.smtp.ok ? null : result.smtp.error,
    });

    res.json({ result, mailbox: present(getMailbox(mailbox.id)) });
  } catch (error) {
    next(error);
  }
});

/** One real message, out of this mailbox, to prove the path end to end. */
mailboxesRouter.post('/:id/test-send', requireAdmin, validate(z.object({
  to: z.string().trim().email().optional(),
})), async (req, res, next) => {
  try {
    const mailbox = getMailbox(req.params.id);
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

    const to = req.body.to ?? req.user.email;

    const { message } = composeMessage({
      mailbox,
      campaign: {
        id: null,
        subject: `Test from ${mailbox.label}`,
        html_body:
          '<p>Hi {{first_name}},</p>'
          + `<p>This is a test from <strong>${mailbox.label}</strong> &lt;${mailbox.from_email}&gt;.</p>`
          + '<p>Open "Show original" and confirm SPF, DKIM and DMARC all report PASS.</p>',
        from_name: '',
        from_email: '',
        reply_to: '',
        preheader: '',
        tracking_enabled: false,
      },
      step: { subject: '', html_body: '', preheader: '' },
      contact: {
        // Null rather than a phantom 0, so the unsubscribe token carries no
        // id that no table could satisfy.
        id: null,
        email: to,
        first_name: 'there',
        last_name: '',
        company: '',
        custom_fields: '{}',
      },
    });

    message.subject = `[TEST] ${message.subject}`;
    await (await getTransport(mailbox)).sendMail(message);

    await logAction({
      userId: req.user.id,
      action: 'mailbox.test_send',
      entity: 'mailbox',
      entityId: mailbox.id,
      detail: { to },
    });

    res.json({ ok: true, sentTo: to, from: mailbox.from_email });
  } catch (error) {
    next(Object.assign(new Error(`Test send failed: ${error.message}`), { status: 502 }));
  }
});

mailboxesRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const mailbox = getMailbox(req.params.id);
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

    // History is attributed to the mailbox that sent it. Removing one that
    // campaigns point at would either orphan them or rewrite who sent what,
    // so deactivation is the operation offered instead.
    const inUse = await campaignsUsingMailbox(mailbox.id);
    if (inUse > 0) {
      return res.status(409).json({
        error: `${inUse} campaign(s) send from "${mailbox.label}".`,
        detail: 'Deactivate it instead - it will stop being offered for new campaigns, and its history stays intact.',
      });
    }

    await removeMailbox(mailbox.id);
    markTransportStale(mailbox.id);
    await logAction({
      userId: req.user.id,
      action: 'mailbox.delete',
      entity: 'mailbox',
      entityId: mailbox.id,
      detail: { label: mailbox.label },
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
