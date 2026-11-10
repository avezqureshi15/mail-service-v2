import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { queryOne, execute } from '../db/index.js';
import { checkDomain } from '../lib/dns-check.js';
import { getSettings, setSettings, warmupStage, DEFAULT_SETTINGS } from '../db/repositories/settings.js';
import { recentDeliveryHealth } from '../db/repositories/jobs.js';
import { countByStatus } from '../db/repositories/contacts.js';
import { countSuppressions } from '../db/repositories/suppressions.js';
import { listCampaigns } from '../db/repositories/campaigns.js';
import { recentAudit, logAction } from '../db/repositories/users.js';
import { senderStatus } from '../workers/sender.js';
import { scanInbox } from '../workers/inbox-poller.js';
import { requireAuth, requireAdmin, validate } from '../middleware/index.js';

export const healthRouter = Router();

/** Unauthenticated liveness probe. Reveals nothing. */
healthRouter.get('/healthz', (_req, res) => res.json({ ok: true }));

healthRouter.use(requireAuth);

/** Everything the dashboard needs in one call. */
healthRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const settings = getSettings();

    // Five independent reads, so they go out together rather than one after
    // another - the difference is noticeable now each is a network round trip.
    const [cached, delivery, contacts, suppressions, campaigns] = await Promise.all([
      queryOne('SELECT * FROM domain_health WHERE id = 1'),
      recentDeliveryHealth(24),
      countByStatus(),
      countSuppressions(),
      listCampaigns({ limit: 5 }),
    ]);

    res.json({
      domainAuth: cached
        ? {
          spfOk: cached.spf_ok,
          dkimOk: cached.dkim_ok,
          dmarcOk: cached.dmarc_ok,
          checkedAt: cached.checked_at,
          detail: cached.detail,
        }
        : null,
      sender: await senderStatus(),
      warmup: warmupStage(settings),
      sequenceWaitUnit: settings.sequenceWaitUnit,
      delivery,
      contacts,
      suppressions,
      campaigns: campaigns.rows,
      config: {
        sendingDomain: env.SENDING_DOMAIN,
        fromAddress: env.MAIL_FROM_ADDRESS,
        provider: { id: env.provider.id, label: env.provider.label, dailyLimit: env.provider.dailyLimit, note: env.provider.dailyLimitNote },
        trackingConfigured: env.trackingEnabled,
        imapEnabled: env.IMAP_ENABLED,
      },
    });
  } catch (error) {
    next(error);
  }
});

/** Live DNS re-check, on demand from the dashboard. */
healthRouter.post('/domain-check', async (_req, res, next) => {
  try {
    const result = await checkDomain(env.SENDING_DOMAIN, env.DKIM_SELECTOR, { provider: env.provider });
    await execute(
      `INSERT INTO domain_health (id, spf_ok, dkim_ok, dmarc_ok, detail, checked_at)
       VALUES (1, $1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         spf_ok = excluded.spf_ok, dkim_ok = excluded.dkim_ok, dmarc_ok = excluded.dmarc_ok,
         detail = excluded.detail, checked_at = excluded.checked_at`,
      [result.spf.ok, result.dkim.ok, result.dmarc.ok, JSON.stringify(result)],
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

healthRouter.post('/inbox-scan', requireAdmin, async (_req, res, next) => {
  if (!env.IMAP_ENABLED) return res.status(400).json({ error: 'IMAP is disabled' });
  try {
    res.json(await scanInbox());
  } catch (error) {
    next(Object.assign(new Error(`Inbox scan failed: ${error.message}`), { status: 502 }));
  }
});

// --- Settings --------------------------------------------------------------

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', (_req, res) => {
  res.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS });
});

const settingsSchema = z.object({
  dailyCap: z.coerce.number().int().min(1).max(5000).optional(),
  hourlyCap: z.coerce.number().int().min(1).max(1000).optional(),
  minIntervalSeconds: z.coerce.number().int().min(1).max(3600).optional(),
  jitterPercent: z.coerce.number().int().min(0).max(100).optional(),
  perDomainHourlyCap: z.coerce.number().int().min(1).max(500).optional(),
  sendWindowStartHour: z.coerce.number().int().min(0).max(23).optional(),
  sendWindowEndHour: z.coerce.number().int().min(1).max(24).optional(),
  sendOnWeekends: z.boolean().optional(),
  warmupEnabled: z.boolean().optional(),
  warmupStartedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  maxBounceRatePercent: z.coerce.number().min(0).max(100).optional(),
  maxComplaintRatePercent: z.coerce.number().min(0).max(100).optional(),
  softBounceLimit: z.coerce.number().int().min(1).max(20).optional(),
  maxSendAttempts: z.coerce.number().int().min(1).max(10).optional(),
  requireDomainAuth: z.boolean().optional(),
  excludeRoleAccounts: z.boolean().optional(),
  sequenceWaitUnit: z.enum(['days', 'minutes']).optional(),
}).refine((s) => s.sendWindowEndHour === undefined || s.sendWindowStartHour === undefined
  || s.sendWindowEndHour > s.sendWindowStartHour, {
  message: 'Send window end hour must be after the start hour',
  path: ['sendWindowEndHour'],
});

settingsRouter.patch('/', requireAdmin, validate(settingsSchema), async (req, res, next) => {
  // A cap above what the provider allows does not raise throughput - it just
  // runs the account into a sending suspension partway through a campaign.
  const limit = env.provider.dailyLimit;
  if (req.body.dailyCap && limit && req.body.dailyCap > limit) {
    return res.status(400).json({
      error: `Daily cap of ${req.body.dailyCap} exceeds what ${env.provider.label} allows (~${limit}/day).`,
      detail: env.provider.dailyLimitNote,
    });
  }

  // Reject a combination that cannot actually deliver the daily figure.
  // Silently-unreachable config is worse than a rejected change: the campaign
  // simply never finishes and nothing explains why.
  const merged = { ...getSettings(), ...req.body };
  const windowHours = Math.max(1, merged.sendWindowEndHour - merged.sendWindowStartHour);
  const byHour = merged.hourlyCap * windowHours;
  const byInterval = Math.floor((windowHours * 3600) / merged.minIntervalSeconds);
  const reachable = Math.min(byHour, byInterval);

  if (merged.dailyCap > reachable) {
    return res.status(400).json({
      error: `A daily cap of ${merged.dailyCap} is unreachable with these limits - at most ${reachable} can be sent in the ${windowHours}h window.`,
      detail: `Raise the hourly cap (currently ${merged.hourlyCap}/h) or shorten the send interval (currently ${merged.minIntervalSeconds}s), or widen the sending window.`,
    });
  }

  try {
    const updated = await setSettings(req.body);
    await logAction({ userId: req.user.id, action: 'settings.update', detail: req.body });
    res.json({ settings: updated });
  } catch (error) {
    next(error);
  }
});

settingsRouter.get('/audit', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ entries: await recentAudit(100) });
  } catch (error) {
    next(error);
  }
});
