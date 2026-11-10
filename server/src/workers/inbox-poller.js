import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { env } from '../config/env.js';
import { queryOne, execute } from '../db/index.js';
import { getSettings } from '../db/repositories/settings.js';
import { suppress } from '../db/repositories/suppressions.js';
import { setStatusByEmail, findByEmail } from '../db/repositories/contacts.js';
import { exitEnrollment } from '../db/repositories/campaigns.js';
import { findJobByMessageId } from '../db/repositories/jobs.js';
import { connectionTargetFor } from '../lib/resolve-host.js';
import { applyUnsubscribe } from '../lib/apply-unsubscribe.js';

/**
 * Reads the Zoho mailbox and does two jobs in one pass.
 *
 *  1. Bounce and complaint handling - hard bounces are suppressed
 *     immediately, repeated soft bounces after a threshold, complaints
 *     always. Left unhandled, repeat sends to dead addresses are what
 *     destroys a sending reputation.
 *
 *  2. Reply detection - inbound mail is matched to our Message-IDs via
 *     In-Reply-To / References. A match halts that contact's sequence, so
 *     nobody is chased after they have already answered. We record only that
 *     a reply happened; the message itself stays in the rep's inbox.
 */

let timer = null;
let running = false;
let scanning = false;

const log = (...args) => console.log('[inbox]', ...args);

async function connect() {
  // Resolved up front so a broken local resolver cannot stop bounce and
  // reply detection; `servername` keeps certificate validation on the
  // hostname even when the connection goes to an IP.
  const target = await connectionTargetFor(env.IMAP_HOST);

  return new ImapFlow({
    host: target.host,
    port: env.IMAP_PORT,
    secure: true,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername: target.servername,
    },
    logger: false,
  });
}

// --- Message-ID extraction -------------------------------------------------

const MESSAGE_ID_PATTERN = /<[^<>\s]+@[^<>\s]+>/g;

/**
 * Our own Message-IDs are recognisable because we generate them on the
 * sending domain. Pull every candidate out of a blob of text and return the
 * first one that matches a send job.
 */
async function findOurMessageId(...sources) {
  for (const source of sources) {
    if (!source) continue;
    const text = Array.isArray(source) ? source.join(' ') : String(source);
    const candidates = text.match(MESSAGE_ID_PATTERN) ?? [];
    for (const candidate of candidates) {
      if (!candidate.includes(`@${env.SENDING_DOMAIN}`)) continue;
      const job = await findJobByMessageId(candidate);
      if (job) return { messageId: candidate, job };
    }
  }
  return null;
}

// --- Bounce classification -------------------------------------------------

/**
 * Prefers the machine-readable DSN status over scraping the human-readable
 * text, falling back to the SMTP reply code and then to well-known phrases.
 */
export function classifyBounce({ dsnStatus = '', smtpCode = '', text = '' }) {
  const status = String(dsnStatus).trim();

  // RFC 3463: 5.x.x permanent, 4.x.x transient.
  if (/^5\.\d+\.\d+$/.test(status)) return { type: 'hard', code: status };
  if (/^4\.\d+\.\d+$/.test(status)) return { type: 'soft', code: status };

  const code = String(smtpCode).match(/\b([45]\d{2})\b/)?.[1];
  if (code?.startsWith('5')) return { type: 'hard', code };
  if (code?.startsWith('4')) return { type: 'soft', code };

  const body = String(text).toLowerCase();

  if (/(user|mailbox|recipient|address)\s+(unknown|not found|does not exist|doesn't exist)/.test(body)
    || /no such (user|mailbox|recipient)/.test(body)
    || /invalid (recipient|mailbox|address)/.test(body)
    || /550[\s-]*5\.1\.1/.test(body)
    || /account (has been )?(disabled|deactivated|closed|terminated)/.test(body)
    || /domain (not found|does not exist)/.test(body)) {
    return { type: 'hard', code: code ?? '' };
  }

  if (/(mailbox|quota|storage).{0,20}(full|exceeded|limit)/.test(body)
    || /over quota/.test(body)
    || /temporar(y|ily)/.test(body)
    || /try again later|deferred|greylist/.test(body)
    || /out of office|vacation|auto[\s-]?reply/.test(body)) {
    return { type: 'soft', code: code ?? '' };
  }

  return { type: 'unknown', code: code ?? '' };
}

export function isComplaint(parsed) {
  const contentType = String(parsed.headers.get('content-type')?.value ?? '').toLowerCase();
  if (contentType.includes('report-type=feedback-report')) return true;
  const subject = String(parsed.subject ?? '').toLowerCase();
  return /abuse report|spam complaint|feedback(-| )?loop|this is an email abuse report/.test(subject);
}

export function isDeliveryReport(parsed) {
  const contentType = String(parsed.headers.get('content-type')?.value ?? '').toLowerCase();
  if (contentType.includes('report-type=delivery-status') || contentType.includes('multipart/report')) return true;

  const from = String(parsed.from?.text ?? '').toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery (subsystem|system)/.test(from)) return true;

  const subject = String(parsed.subject ?? '').toLowerCase();
  return /undeliverable|delivery (status notification|has failed|failure)|returned mail|mail delivery failed|failure notice/
    .test(subject);
}

/** Pull the DSN fields out of the message/delivery-status part. */
function readDeliveryStatus(parsed) {
  const raw = `${parsed.text ?? ''}\n${parsed.html ?? ''}`;
  return {
    dsnStatus: raw.match(/^\s*Status:\s*([245]\.\d+\.\d+)/mi)?.[1] ?? '',
    smtpCode: raw.match(/^\s*Diagnostic-Code:\s*smtp;\s*(\d{3})/mi)?.[1] ?? '',
    finalRecipient: raw.match(/^\s*(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*(\S+@\S+)/mi)?.[1] ?? '',
    diagnostic: raw.match(/^\s*Diagnostic-Code:\s*(.+)$/mi)?.[1]?.trim() ?? '',
  };
}

// --- Handlers --------------------------------------------------------------

// ON CONFLICT so a re-read message, or a provider that sends the same DSN
// twice, cannot double-count against the bounce rate that auto-pauses sending.
function recordBounce(values) {
  return execute(
    `INSERT INTO bounces (message_id, contact_id, campaign_id, email, bounce_type, smtp_code, diagnostic)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id, email, bounce_type) DO NOTHING`,
    values,
  );
}

async function consecutiveSoftBounces(email) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM bounces
      WHERE email = $1 AND bounce_type = 'soft' AND created_at >= now() - interval '30 days'`,
    [email],
  );
  return row.n;
}

export async function handleBounce({ parsed, settings }) {
  const dsn = readDeliveryStatus(parsed);
  const match = await findOurMessageId(
    parsed.headers.get('in-reply-to'),
    parsed.references,
    parsed.text,
    parsed.html,
  );

  const email = (match?.job?.contact_email ?? dsn.finalRecipient ?? '').trim().toLowerCase();
  if (!email) return false;

  const { type, code } = classifyBounce({
    dsnStatus: dsn.dsnStatus,
    smtpCode: dsn.smtpCode,
    text: `${parsed.subject ?? ''}\n${parsed.text ?? ''}`,
  });

  await recordBounce([
    match?.messageId ?? null,
    match?.job?.contact_id ?? null,
    match?.job?.campaign_id ?? null,
    email,
    type,
    code,
    dsn.diagnostic.slice(0, 500),
  ]);

  if (type === 'hard') {
    await suppress({ email, reason: 'hard_bounce', source: 'imap', notes: dsn.diagnostic.slice(0, 200) });
    await setStatusByEmail(email, 'bounced');
    const contact = await findByEmail(email);
    if (contact) await exitEnrollment({ contactId: contact.id, reason: 'bounced' });
    log(`hard bounce, suppressed ${email} (${code || 'no code'})`);
    return true;
  }

  if (type === 'soft' && await consecutiveSoftBounces(email) >= settings.softBounceLimit) {
    await suppress({ email, reason: 'soft_bounce_limit', source: 'imap', notes: `${settings.softBounceLimit} soft bounces` });
    await setStatusByEmail(email, 'bounced');
    const contact = await findByEmail(email);
    if (contact) await exitEnrollment({ contactId: contact.id, reason: 'bounced' });
    log(`soft bounce limit reached, suppressed ${email}`);
    return true;
  }

  log(`${type} bounce recorded for ${email}`);
  return true;
}

export async function handleComplaint({ parsed }) {
  const match = await findOurMessageId(parsed.text, parsed.html, parsed.references);
  const email = (match?.job?.contact_email
    ?? `${parsed.text ?? ''}`.match(/Original-Rcpt-To:\s*(\S+@\S+)/i)?.[1]
    ?? '').trim().toLowerCase();

  if (!email) return false;

  await recordBounce([
    match?.messageId ?? null,
    match?.job?.contact_id ?? null,
    match?.job?.campaign_id ?? null,
    email,
    'complaint',
    '',
    'Feedback loop complaint',
  ]);

  // A complaint is the strongest possible signal. Suppress immediately.
  await suppress({ email, reason: 'complaint', source: 'feedback_loop' });
  await setStatusByEmail(email, 'complained');
  const contact = await findByEmail(email);
  if (contact) await exitEnrollment({ contactId: contact.id, reason: 'complained' });

  log(`complaint, suppressed ${email}`);
  return true;
}

export async function handleReply({ parsed }) {
  const match = await findOurMessageId(parsed.headers.get('in-reply-to'), parsed.references);
  if (!match?.job) return false;

  const alreadyRecorded = await queryOne(
    'SELECT 1 FROM replies WHERE contact_id = $1 AND campaign_id = $2 LIMIT 1',
    [match.job.contact_id, match.job.campaign_id],
  );

  if (!alreadyRecorded) {
    await execute(
      'INSERT INTO replies (contact_id, campaign_id, in_reply_to, email) VALUES ($1, $2, $3, $4)',
      [
        match.job.contact_id,
        match.job.campaign_id,
        match.messageId,
        match.job.contact_email ?? '',
      ],
    );
  }

  // Stop every active sequence for this contact, not just the one they
  // replied to - they have engaged, so further cold follow-ups are noise.
  const exited = await exitEnrollment({ contactId: match.job.contact_id, reason: 'replied' });
  if (exited > 0) {
    log(`reply from ${match.job.contact_email} - exited ${exited} sequence(s)`);
  }
  return true;
}


/**
 * Honours the `mailto:` option in our own List-Unsubscribe header.
 *
 * Every message we send advertises two ways out: an HTTPS link and a mailto.
 * Clients that do not implement RFC 8058 one-click use the mailto, which
 * arrives here as an ordinary email. Advertising an opt-out and then
 * ignoring it is the worst of both worlds - the recipient believes they have
 * unsubscribed, keeps receiving mail, and reports it as spam.
 */
// Anchored and word-bounded on purpose. Without the boundary "Stopping by
// next week" would read as an opt-out and silently suppress a warm lead.
const UNSUBSCRIBE_SUBJECT = /^\s*(re:\s*)?(unsubscribe|remove me|opt[- ]?out|stop)\b/i;

export async function handleUnsubscribeRequest({ parsed }) {
  const subject = String(parsed.subject ?? '');
  if (!UNSUBSCRIBE_SUBJECT.test(subject)) return false;

  const from = parsed.from?.value?.[0]?.address?.trim().toLowerCase();
  if (!from) return false;

  // Only act on addresses we actually mail. Without this, a newsletter whose
  // subject happens to start with "unsubscribe" would add a stranger to the
  // suppression list.
  const contact = await findByEmail(from);
  if (!contact) return false;

  await applyUnsubscribe({
    email: from,
    contactId: contact.id,
    method: 'mailto',
    userAgent: 'inbox-poller',
  });

  log(`mailto unsubscribe from ${from}`);
  return true;
}

// --- Scan ------------------------------------------------------------------

// How far back to look on the very first run, before a position is known.
// Enough to catch anything that arrived while the service was being set up,
// without wading through years of archive.
const FIRST_RUN_DAYS = 7;

const readState = () => queryOne('SELECT * FROM imap_state WHERE id = 1');

const writeState = (uidValidity, lastUid) => execute(
  `UPDATE imap_state SET uid_validity = $1, last_uid = $2, updated_at = now() WHERE id = 1`,
  [String(uidValidity), lastUid],
);

/**
 * Reads anything that has arrived since the last pass.
 *
 * Positioned by UID rather than by read state. UIDs only ever increase, so
 * "greater than the last one handled" is exactly the new mail - whether or
 * not a human has already opened it, and however large the mailbox is. The
 * poller never changes a flag, because this is somebody's real inbox and
 * marking their mail read to keep its own bookmark would be rude and
 * unreliable.
 */
export async function scanInbox() {
  if (scanning) return { skipped: true };
  scanning = true;

  const settings = getSettings();
  const client = await connect();
  const counts = { examined: 0, bounces: 0, complaints: 0, replies: 0, unsubscribes: 0 };

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const box = client.mailbox;
      const state = await readState();
      const validityChanged = state.uid_validity
        && String(state.uid_validity) !== String(box.uidValidity);

      let range;
      if (!state.uid_validity || validityChanged) {
        // No position, or the server renumbered the mailbox. Establish one
        // from recent mail rather than trusting stale UIDs.
        if (validityChanged) log('mailbox UIDVALIDITY changed - re-establishing position');
        const since = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000);
        const recent = await client.search({ since }, { uid: true });
        range = recent ?? [];
        log(`first pass: examining ${range.length} message(s) from the last ${FIRST_RUN_DAYS} days`);
      } else {
        const found = await client.search({ uid: `${state.last_uid + 1}:*` }, { uid: true });
        // An open-ended UID range always returns at least the newest message,
        // even when nothing is actually newer; filter it out.
        range = (found ?? []).filter((uid) => uid > state.last_uid);
      }

      if (range.length === 0) {
        await writeState(box.uidValidity, state.last_uid);
        return counts;
      }

      // Oldest first, so an interrupted pass resumes cleanly.
      range.sort((a, b) => a - b);

      // Bounded so one pass cannot run forever; the rest follows next tick.
      const batch = range.slice(0, 200);
      let highest = state.last_uid;

      for (const uid of batch) {
        let parsed;
        try {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message?.source) { highest = Math.max(highest, uid); continue; }
          parsed = await simpleParser(message.source);
        } catch (error) {
          log(`could not read UID ${uid}: ${error.message}`);
          highest = Math.max(highest, uid);
          continue;
        }

        counts.examined += 1;

        try {
          if (isComplaint(parsed)) {
            if (await handleComplaint({ parsed })) counts.complaints += 1;
          } else if (isDeliveryReport(parsed)) {
            if (await handleBounce({ parsed, settings })) counts.bounces += 1;
          } else if (await handleUnsubscribeRequest({ parsed })) {
            // Checked before reply matching: "unsubscribe" sent as a reply
            // is an opt-out first and a reply second.
            counts.unsubscribes += 1;
          } else if (await handleReply({ parsed })) {
            counts.replies += 1;
          }
        } catch (error) {
          // One unparseable message must not stall the queue behind it.
          log(`error handling UID ${uid}: ${error.message}`);
        }

        // Advance past it either way, so a message we cannot match is not
        // re-examined on every pass for the life of the mailbox.
        highest = Math.max(highest, uid);
      }

      await writeState(box.uidValidity, highest);

      if (range.length > batch.length) {
        log(`${range.length - batch.length} message(s) left for the next pass`);
      }
    } finally {
      lock.release();
    }
  } finally {
    scanning = false;
    try {
      await client.logout();
    } catch {
      // Connection may already be gone; nothing to do.
    }
  }

  if (counts.bounces || counts.complaints || counts.replies || counts.unsubscribes) {
    log(`examined ${counts.examined}: ${counts.bounces} bounce(s), ${counts.complaints} complaint(s), ${counts.replies} reply/replies, ${counts.unsubscribes} unsubscribe(s)`);
  }
  return counts;
}


async function loop() {
  if (!running) return;
  try {
    await scanInbox();
  } catch (error) {
    log(`scan failed: ${error.message}`);
  }
  if (running) timer = setTimeout(loop, env.IMAP_POLL_SECONDS * 1000);
}

export function startInboxPoller() {
  if (running) return;
  if (!env.IMAP_ENABLED) {
    log('disabled (IMAP_ENABLED=false) - bounce handling and reply detection are OFF');
    return;
  }
  running = true;
  log(`worker started, polling every ${env.IMAP_POLL_SECONDS}s`);
  timer = setTimeout(loop, 10_000);
}

export function stopInboxPoller() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
