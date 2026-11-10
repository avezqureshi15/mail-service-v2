import { query, queryOne, execute, transaction } from '../index.js';
import { normaliseEmail } from './suppressions.js';

export function domainOf(email) {
  const at = String(email ?? '').lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/**
 * Queues one job per contact in a single statement. The arrays go through
 * `unnest` rather than a loop, so a 3,000-contact campaign starts in one
 * round trip instead of three thousand - which matters far more now the
 * database is across a network.
 */
export async function queueJobs(campaignId, contacts, stepNo = 1, tenantId = 1) {
  if (contacts.length === 0) return 0;
  return execute(
    `INSERT INTO send_jobs (tenant_id, campaign_id, contact_id, step_no, recipient_domain, next_attempt_at)
     SELECT $1, $2, c.id, $3, c.domain, now()
       FROM unnest($4::int[], $5::text[]) AS c(id, domain)
     ON CONFLICT (campaign_id, contact_id, step_no) DO NOTHING`,
    [tenantId, campaignId, stepNo, contacts.map((c) => c.id), contacts.map((c) => domainOf(c.email))],
  );
}

export async function queueSingleJob({ campaignId, contactId, email, stepNo, tenantId = 1 }) {
  return (await execute(
    `INSERT INTO send_jobs (tenant_id, campaign_id, contact_id, step_no, recipient_domain, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (campaign_id, contact_id, step_no) DO NOTHING`,
    [tenantId, campaignId, contactId, stepNo, domainOf(email)],
  )) > 0;
}

/**
 * Atomically takes the next due job.
 *
 * `FOR UPDATE ... SKIP LOCKED` is what makes this safe: the row is locked as
 * it is selected, and another worker looking at the same instant skips past
 * it instead of blocking or taking it as well. Two ticks cannot claim the
 * same job, which would mean mailing one person twice. It also improves on
 * the SQLite version, which serialised the whole database to achieve this -
 * several senders can now run at once.
 *
 * Suppression is re-checked inside the same transaction, which is what makes
 * an unsubscribe arriving mid-campaign take effect for the rest of the run.
 *
 * @param {string[]} blockedDomains Receiving domains that have hit their
 *   hourly pacing limit; skipped until the bucket drains.
 */
export function claimNextJob(blockedDomains = []) {
  return transaction(async (tx) => {
    const job = await tx.queryOne(
      `SELECT j.id, j.tenant_id, j.campaign_id, j.contact_id, j.step_no, j.attempts,
              c.email, c.first_name, c.last_name, c.company, c.custom_fields,
              c.status AS contact_status
         FROM send_jobs j
         JOIN contacts  c ON c.id = j.contact_id
         JOIN campaigns k ON k.id = j.campaign_id
        WHERE j.status = 'queued'
          AND j.next_attempt_at <= now()
          AND k.status = 'sending'
          AND NOT (j.recipient_domain = ANY($1::text[]))
        ORDER BY j.next_attempt_at, j.id
        LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
      [blockedDomains],
    );

    if (!job) return null;

    await tx.execute(
      "UPDATE send_jobs SET status = 'sending', locked_at = now() WHERE id = $1",
      [job.id],
    );

    const suppressed = await tx.queryOne(
      'SELECT reason FROM suppressions WHERE tenant_id = $1 AND lower(email) = $2',
      [job.tenant_id, normaliseEmail(job.email)],
    );

    if (suppressed) {
      await tx.execute(
        "UPDATE send_jobs SET status = 'skipped', skip_reason = $1 WHERE id = $2",
        [`suppressed:${suppressed.reason}`, job.id],
      );
      return { skipped: true };
    }

    if (job.contact_status !== 'active') {
      await tx.execute(
        "UPDATE send_jobs SET status = 'skipped', skip_reason = $1 WHERE id = $2",
        [`contact_status:${job.contact_status}`, job.id],
      );
      return { skipped: true };
    }

    return job;
  });
}

export function markSent(jobId, messageId) {
  return execute(
    `UPDATE send_jobs
        SET status = 'sent', message_id = $1, sent_at = now(),
            attempts = attempts + 1, locked_at = NULL, error = NULL
      WHERE id = $2`,
    [messageId, jobId],
  );
}

/** Re-queues with exponential backoff, or gives up at maxAttempts. */
export async function markFailed(jobId, error, { maxAttempts = 3 } = {}) {
  const row = await queryOne('SELECT attempts FROM send_jobs WHERE id = $1', [jobId]);
  const attempts = (row?.attempts ?? 0) + 1;
  const message = String(error ?? '').slice(0, 1000);

  if (attempts >= maxAttempts) {
    await execute(
      "UPDATE send_jobs SET status = 'failed', attempts = $1, error = $2, locked_at = NULL WHERE id = $3",
      [attempts, message, jobId],
    );
    return { retrying: false, attempts };
  }

  // 5 min, 25 min, 125 min ...
  const delayMinutes = 5 * 5 ** (attempts - 1);
  await execute(
    `UPDATE send_jobs
        SET status = 'queued', attempts = $1, error = $2, locked_at = NULL,
            next_attempt_at = now() + make_interval(mins => $3)
      WHERE id = $4`,
    [attempts, message, delayMinutes, jobId],
  );

  return { retrying: true, attempts, delayMinutes };
}

/** Releases rows left in 'sending' by a crash, so they retry rather than stick. */
export function releaseStaleLocks(olderThanMinutes = 15) {
  return execute(
    `UPDATE send_jobs
        SET status = 'queued', locked_at = NULL
      WHERE status = 'sending' AND locked_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes],
  );
}

// --- Pacing ----------------------------------------------------------------

export async function sentInLastHour() {
  return (await queryOne(
    "SELECT COUNT(*) AS n FROM send_jobs WHERE status = 'sent' AND sent_at >= now() - interval '1 hour'",
  )).n;
}

/**
 * Receiving domains that have had too many messages in the past hour.
 * Sending 200 gmail.com addresses inside a minute is a bulk signature even
 * when the overall rate is modest.
 */
export async function domainsOverHourlyCap(cap) {
  const rows = await query(
    `SELECT recipient_domain FROM send_jobs
      WHERE status = 'sent' AND sent_at >= now() - interval '1 hour'
      GROUP BY recipient_domain
     HAVING COUNT(*) >= $1`,
    [cap],
  );
  return rows.map((row) => row.recipient_domain);
}

export async function sentToday() {
  const row = await queryOne('SELECT sent_count FROM send_counters WHERE day = CURRENT_DATE');
  return row?.sent_count ?? 0;
}

export function incrementSentToday() {
  return execute(
    `INSERT INTO send_counters (day, sent_count) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET sent_count = send_counters.sent_count + 1`,
  );
}

export async function hasPendingWork() {
  const row = await queryOne(
    `SELECT 1 FROM send_jobs j
       JOIN campaigns k ON k.id = j.campaign_id
      WHERE j.status = 'queued' AND k.status = 'sending'
      LIMIT 1`,
  );
  return Boolean(row);
}

// --- Lookups and stats -----------------------------------------------------

export function findJobByMessageId(messageId) {
  return queryOne(
    `SELECT j.*, c.email AS contact_email
       FROM send_jobs j
       LEFT JOIN contacts c ON c.id = j.contact_id
      WHERE j.message_id = $1`,
    [messageId],
  );
}

export async function campaignJobStats(campaignId) {
  const rows = await query(
    'SELECT status, COUNT(*) AS n FROM send_jobs WHERE campaign_id = $1 GROUP BY status',
    [campaignId],
  );
  const stats = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) stats[row.status] = row.n;
  stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
  return stats;
}

export function campaignRecipients(campaignId, { limit = 100, offset = 0 } = {}) {
  return query(
    `SELECT j.id, j.status, j.step_no, j.attempts, j.sent_at, j.error, j.skip_reason, j.message_id,
            c.id AS contact_id, c.email, c.first_name, c.last_name, c.company,
            c.status AS contact_status,
            (SELECT COUNT(*) FROM tracking_events t
              WHERE t.message_id = j.message_id AND t.event_type = 'open'  AND t.is_bot = FALSE) AS opens,
            (SELECT COUNT(*) FROM tracking_events t
              WHERE t.message_id = j.message_id AND t.event_type = 'click' AND t.is_bot = FALSE) AS clicks,
            (SELECT COUNT(*) FROM replies r
              WHERE r.contact_id = c.id AND r.campaign_id = j.campaign_id)                       AS replies,
            (SELECT b.bounce_type FROM bounces b WHERE b.message_id = j.message_id LIMIT 1)      AS bounce_type
       FROM send_jobs j
       JOIN contacts c ON c.id = j.contact_id
      WHERE j.campaign_id = $1
      ORDER BY j.step_no, j.id
      LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset],
  );
}

/**
 * Rolling health used for the auto-pause guard. Bounce and complaint rates
 * are what receivers judge a sender on, so a spike must stop the queue.
 */
export async function recentDeliveryHealth(windowHours = 24) {
  const row = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM send_jobs
         WHERE status = 'sent' AND sent_at >= now() - make_interval(hours => $1))                  AS sent,
       (SELECT COUNT(*) FROM bounces
         WHERE bounce_type = 'hard'      AND created_at >= now() - make_interval(hours => $1))     AS hard,
       (SELECT COUNT(*) FROM bounces
         WHERE bounce_type = 'soft'      AND created_at >= now() - make_interval(hours => $1))     AS soft,
       (SELECT COUNT(*) FROM bounces
         WHERE bounce_type = 'complaint' AND created_at >= now() - make_interval(hours => $1))     AS complaints`,
    [windowHours],
  );

  const pct = (value) => (row.sent > 0 ? Number(((value / row.sent) * 100).toFixed(2)) : 0);

  return {
    sent: row.sent,
    hardBounces: row.hard,
    softBounces: row.soft,
    complaints: row.complaints,
    bounceRate: pct(row.hard + row.soft),
    complaintRate: pct(row.complaints),
  };
}

// --- Manual retry ----------------------------------------------------------

/**
 * Jobs a retry would act on: ones that gave up, and ones still waiting out a
 * backoff after an error. A plain queued job with no error is excluded - it
 * has not failed, it just has not had its turn yet.
 */
const RETRYABLE = `
  campaign_id = $1
  AND (status = 'failed' OR (status = 'queued' AND error IS NOT NULL))
`;

export function retryableJobs(campaignId) {
  return query(`SELECT id, error, attempts FROM send_jobs WHERE ${RETRYABLE}`, [campaignId]);
}

/**
 * Clears the backoff and attempt count so the sender picks the job up next
 * tick. Attempts reset to zero deliberately: a retry is requested because
 * the cause was fixed, and leaving the counter at 2 of 3 would give the job
 * one try before giving up again.
 */
export function retryJobs(campaignId, jobId = null) {
  return execute(
    `UPDATE send_jobs
        SET status = 'queued', attempts = 0, error = NULL,
            locked_at = NULL, next_attempt_at = now()
      WHERE ${RETRYABLE}
        AND ($2::int IS NULL OR id = $2::int)`,
    [campaignId, jobId],
  );
}
