import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { queryOne, execute } from '../db/index.js';
import { getSettings } from '../db/repositories/settings.js';
import {
  defaultMailbox, activeMailboxes, getMailbox, mailboxSecrets, sendingDomains,
  recordMailboxError,
} from '../db/repositories/mailboxes.js';
import { suppress } from '../db/repositories/suppressions.js';
import { setStatusByEmail, findByEmail } from '../db/repositories/contacts.js';
import { exitEnrollment } from '../db/repositories/campaigns.js';
import { findJobByMessageId } from '../db/repositories/jobs.js';
import {
  predictionForEmail, recordPredictionEvent, refreshPredictionOutcome,
  confirmPattern, rejectPattern,
} from '../db/repositories/predictions.js';
import { classifyBounceReason } from '../lib/bounce-reason.js';
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
/** Mailbox ids with a scan in flight. */
const scanning = new Set();

const log = (...args) => console.log('[inbox]', ...args);

async function connect(mailbox) {
  // Resolved up front so a broken local resolver cannot stop bounce and
  // reply detection; `servername` keeps certificate validation on the
  // hostname even when the connection goes to an IP.
  const target = await connectionTargetFor(mailbox.imap_host);
  const { imapPassword } = await mailboxSecrets(mailbox.id);

  return new ImapFlow({
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
    // A cheap pre-filter so a long quoted thread does not cost one database
    // lookup per Message-ID it mentions. With several mailboxes there is no
    // single sending domain any more, so it checks all of them - and falls
    // through to the database when none are known, since findJobByMessageId
    // is the authoritative answer either way.
    const domains = sendingDomains();
    for (const candidate of candidates) {
      if (domains.length > 0 && !domains.some((d) => candidate.includes(`@${d}`))) continue;
      const job = await findJobByMessageId(candidate);
      if (job) return { messageId: candidate, job };
    }
  }
  return null;
}

// --- Bounce classification -------------------------------------------------

/**
 * Kept as a thin alias so existing callers and tests keep working. The
 * classification itself lives in `lib/bounce-reason.js`, which is pure and
 * testable without IMAP, and which also returns the reason and the
 * tri-state `learnsAddress` the predictor needs.
 */
export function classifyBounce(input) {
  return classifyBounceReason(input);
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
/**
 * `mailbox_id` comes from the matched send job, NOT from the inbox the
 * message arrived in. A bounce for a message sent by mailbox A can land in
 * mailbox B when the campaign's reply-to points there; recording it against B
 * would show B with a terrible bounce rate having sent nothing.
 *
 * The ON CONFLICT key is deliberately left alone. Adding mailbox_id to it
 * would break the dedupe when the same DSN reaches two inboxes, and that
 * double-count feeds the rate that auto-pauses sending.
 */
function recordBounce(values) {
  return execute(
    `INSERT INTO bounces (message_id, contact_id, campaign_id, email, bounce_type, smtp_code,
                          diagnostic, reason, dsn_status, learns_address, mailbox_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

  const { type, code, reason, learnsAddress } = classifyBounce({
    dsnStatus: dsn.dsnStatus,
    smtpCode: dsn.smtpCode,
    text: `${parsed.subject ?? ''}\n${parsed.text ?? ''}`,
  });

  // An out-of-office is not a delivery failure. It used to be filed as a
  // soft bounce, which counted towards the soft-bounce limit and could
  // eventually suppress a contact who had simply gone on holiday.
  if (type === 'auto_reply') {
    await notePredictionEvent({
      email,
      eventType: 'auto_reply',
      messageId: match?.messageId ?? '',
      contactId: match?.job?.contact_id ?? null,
      // It also proves the mailbox is real, which is worth recording.
      learnsAddress: false,
    });
    log(`auto-reply from ${email}, not counted as a bounce`);
    return true;
  }

  await recordBounce([
    match?.messageId ?? null,
    match?.job?.contact_id ?? null,
    match?.job?.campaign_id ?? null,
    email,
    type,
    code,
    dsn.diagnostic.slice(0, 500),
    reason,
    dsn.dsnStatus,
    learnsAddress,
    match?.job?.mailbox_id ?? null,
  ]);

  // Recorded whatever the reason, including when it teaches us nothing -
  // a delivery result cannot be reconstructed later, and the scorer will
  // want the policy blocks as much as the user-unknowns.
  await notePredictionEvent({
    email,
    eventType: 'bounce',
    reason,
    dsnStatus: dsn.dsnStatus,
    learnsAddress,
    messageId: match?.messageId ?? '',
    contactId: match?.job?.contact_id ?? null,
  });

  if (type === 'hard') {
    await suppress({ email, reason: 'hard_bounce', source: 'imap', notes: dsn.diagnostic.slice(0, 200) });
    await setStatusByEmail(email, 'bounced');
    const contact = await findByEmail(email);
    if (contact) await exitEnrollment({ contactId: contact.id, reason: 'bounced' });
    log(`hard bounce (${reason}), suppressed ${email} (${code || 'no code'})`);
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
    null,
    null,
    null,
    match?.job?.mailbox_id ?? null,
  ]);

  // A complaint is the strongest possible signal. Suppress immediately.
  await suppress({ email, reason: 'complaint', source: 'feedback_loop' });
  await setStatusByEmail(email, 'complained');
  const contact = await findByEmail(email);
  if (contact) await exitEnrollment({ contactId: contact.id, reason: 'complained' });

  log(`complaint, suppressed ${email}`);
  return true;
}

/**
 * Feeds a delivery result back to the Mail Predictor.
 *
 * This is what makes the predictor improve rather than merely repeat
 * itself: a hard bounce retires the format that produced the address, and
 * a reply promotes it from "an operator told us" to "we have proof".
 *
 * Deliberately non-fatal. Bounce and reply handling is the mechanism that
 * protects the sending domain, and it must not be held up by bookkeeping
 * for a secondary feature.
 */
async function notePredictionEvent({
  email, eventType, reason = '', dsnStatus = '',
  learnsAddress = null, messageId = '', contactId = null,
}) {
  try {
    const prediction = await predictionForEmail(email);
    // Only addresses we predicted. A bounce on an imported contact is
    // already fully recorded in `bounces`, and without a prediction there
    // is no format to attribute it to - storing it here would duplicate
    // the log without adding a fact.
    if (!prediction) return;

    await recordPredictionEvent({
      predictionId: prediction.id,
      contactId,
      email,
      eventType,
      reason,
      dsnStatus,
      learnsAddress,
      messageId,
    });
    await refreshPredictionOutcome(prediction.id);

    const where = { domain: prediction.domain, pattern: prediction.pattern };

    // The point of the tri-state. A `5.7.1` block or a full mailbox says
    // nothing about whether the address is right, so it must not retire a
    // format - that was demoting working formats on the strength of a
    // reputation problem.
    if (eventType === 'bounce' && learnsAddress === true) {
      await rejectPattern(where);
    } else if (eventType === 'reply') {
      await confirmPattern(where);
    }
  } catch (error) {
    log(`could not record prediction event for ${email}: ${error.message}`);
  }
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
      `INSERT INTO replies (contact_id, campaign_id, in_reply_to, email, mailbox_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        match.job.contact_id,
        match.job.campaign_id,
        match.messageId,
        match.job.contact_email ?? '',
        // The mailbox that SENT it, not the one it arrived in.
        match.job.mailbox_id ?? null,
      ],
    );
    // A reply is the strongest confirmation there is: a human is reading
    // that mailbox, so the format that produced it is right.
    await notePredictionEvent({
      email: match.job.contact_email ?? '',
      eventType: 'reply',
      messageId: match.messageId ?? '',
      contactId: match.job.contact_id ?? null,
    });
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

// Keyed on the mailbox now that there can be more than one inbox to track.
// The row carried forward by the migration is attached to the seeded mailbox,
// so last_uid survives and the first pass after the upgrade does not re-scan
// a week of mail and replay unsubscribes that are not idempotent.
const readState = (mailboxId) => queryOne(
  'SELECT * FROM imap_state WHERE mailbox_id = $1',
  [mailboxId],
);

const writeState = (mailboxId, uidValidity, lastUid) => execute(
  `INSERT INTO imap_state (mailbox_id, mailbox, uid_validity, last_uid, last_scan_at, updated_at)
   VALUES ($1, 'INBOX', $2, $3, now(), now())
   ON CONFLICT (mailbox_id, mailbox) DO UPDATE SET
     uid_validity = excluded.uid_validity, last_uid = excluded.last_uid,
     last_scan_at = excluded.last_scan_at, updated_at = excluded.updated_at`,
  [mailboxId, String(uidValidity), lastUid],
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
/**
 * Reads one mailbox's inbox.
 *
 * @param {object|number} target The mailbox, or its id. Defaults to the
 *   default mailbox so the manual "scan now" button and the tests can call
 *   this without plumbing one through.
 */
export async function scanInbox(target = null) {
  const mailbox = typeof target === 'number' ? getMailbox(target) : (target ?? defaultMailbox());
  if (!mailbox) {
    log('no mailbox configured - nothing to poll');
    return { skipped: true };
  }
  if (!mailbox.imap_enabled) {
    return { skipped: true, reason: 'IMAP is off for this mailbox' };
  }

  // One scan at a time per mailbox. Each scan can hold a few hundred full
  // message sources in memory through simpleParser, so several at once is a
  // real spike rather than a theoretical one.
  if (scanning.has(mailbox.id)) return { skipped: true };
  scanning.add(mailbox.id);

  const settings = getSettings();
  const client = await connect(mailbox);
  const counts = { examined: 0, bounces: 0, complaints: 0, replies: 0, unsubscribes: 0 };

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const box = client.mailbox;
      // A mailbox that has never been polled has no row yet.
      const state = await readState(mailbox.id) ?? { uid_validity: null, last_uid: 0 };
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
        await writeState(mailbox.id, box.uidValidity, state.last_uid);
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

      await writeState(mailbox.id, box.uidValidity, highest);

      if (range.length > batch.length) {
        log(`${range.length - batch.length} message(s) left for the next pass`);
      }
    } finally {
      lock.release();
    }
  } finally {
    scanning.delete(mailbox.id);
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


// --- Supervisor -------------------------------------------------------------

/**
 * One poller per mailbox with IMAP turned on.
 *
 * Two rules that were not needed when there was a single hard-coded inbox:
 *
 * Authentication failures stop the poller outright instead of retrying on a
 * timer. A wrong password retried every two minutes is how an account gets
 * locked, and multiplying that by the number of mailboxes makes it likely
 * rather than possible. The error is recorded on the mailbox so the Settings
 * tab can show it; fixing the password restarts the poller.
 *
 * Everything else backs off exponentially, so a provider having a bad
 * afternoon is not hammered by every mailbox at once.
 */

const MAX_BACKOFF_MS = 30 * 60_000;
const AUTH_FAILURE = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i;

/** mailboxId -> { timer, stopped, failures } */
const pollers = new Map();

function pollerFor(mailboxId) {
  let state = pollers.get(mailboxId);
  if (!state) {
    state = { timer: null, stopped: false, failures: 0 };
    pollers.set(mailboxId, state);
  }
  return state;
}

async function pollOnce(mailboxId) {
  const state = pollerFor(mailboxId);
  const mailbox = getMailbox(mailboxId);

  if (!mailbox || !mailbox.is_active || !mailbox.imap_enabled) {
    state.stopped = true;
    pollers.delete(mailboxId);
    return;
  }

  try {
    await scanInbox(mailbox);
    state.failures = 0;
    await writeScanOutcome(mailboxId, null);
  } catch (error) {
    if (AUTH_FAILURE.test(error.message)) {
      log(`[${mailbox.label}] authentication failed - poller stopped until the password is fixed`);
      await writeScanOutcome(mailboxId, error.message);
      await recordMailboxError(mailboxId, `IMAP authentication failed: ${error.message}`);
      state.stopped = true;
      pollers.delete(mailboxId);
      return;
    }

    state.failures += 1;
    await writeScanOutcome(mailboxId, error.message);
    log(`[${mailbox.label}] scan failed (${state.failures}): ${error.message}`);
  }

  if (state.stopped || !running) return;

  const base = (mailbox.imap_poll_seconds ?? 120) * 1000;
  const delay = Math.min(base * (2 ** state.failures), MAX_BACKOFF_MS);
  state.timer = setTimeout(() => pollOnce(mailboxId), delay);
}

function writeScanOutcome(mailboxId, error) {
  return execute(
    `UPDATE imap_state
        SET last_scan_at = now(),
            last_error = $1,
            consecutive_failures = CASE WHEN $1::text IS NULL THEN 0 ELSE consecutive_failures + 1 END,
            updated_at = now()
      WHERE mailbox_id = $2`,
    [error ? String(error).slice(0, 1000) : null, mailboxId],
  ).catch(() => 0);
}

/** Starts a poller for any IMAP-enabled mailbox that does not have one. */
function reconcilePollers() {
  if (!running) return;

  let index = 0;
  for (const mailbox of activeMailboxes()) {
    if (!mailbox.imap_enabled) continue;
    if (pollers.has(mailbox.id)) continue;

    const state = pollerFor(mailbox.id);
    // Staggered, so N mailboxes do not all dial out in the same second.
    state.timer = setTimeout(() => pollOnce(mailbox.id), 10_000 + index * 3_000);
    index += 1;
    log(`polling "${mailbox.label}" every ${mailbox.imap_poll_seconds ?? 120}s`);
  }
}

export function startInboxPoller() {
  if (running) return;
  running = true;

  const enabled = activeMailboxes().filter((m) => m.imap_enabled);
  if (enabled.length === 0) {
    log('no mailbox has IMAP enabled - bounce handling and reply detection are OFF');
  }

  reconcilePollers();
  // Picks up mailboxes added or re-enabled while the process is running, and
  // restarts a poller whose password has been corrected.
  timer = setInterval(reconcilePollers, 60_000);
  timer.unref?.();
}

export function stopInboxPoller() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (const state of pollers.values()) {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
  }
  pollers.clear();
}

/** Mailbox ids currently being polled. Exported for the dashboard and tests. */
export function activePollers() {
  return [...pollers.keys()];
}
