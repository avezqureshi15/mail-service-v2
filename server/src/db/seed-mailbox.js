import { queryOne, execute, transaction } from './index.js';
import { env } from '../config/env.js';
import { seal } from '../lib/secret-box.js';

/**
 * Turns the .env mailbox into the first row of the `mailboxes` table.
 *
 * Migration 007 adds every mailbox_id column as nullable precisely so this
 * can run afterwards: SQL cannot read .env, so the backfill has to happen in
 * JS, and it has to happen before any worker starts. A deployment that was
 * sending before the upgrade carries on sending after it, from the same
 * account, with the same warm-up day and the same daily count.
 *
 * Idempotent on a marker row rather than on "the table is empty", so an
 * administrator who deletes the seeded mailbox does not get it recreated on
 * the next restart.
 */

const MARKER = 'mailboxSeeded';

const log = (...args) => console.log('[mailboxes]', ...args);

/**
 * Pacing carried over from the global settings.
 *
 * Read with raw SQL, NOT through `getSettings()`. Once the pacing keys move
 * out of DEFAULT_SETTINGS, `loadSettings()` drops any row whose key it does
 * not recognise - so reading through it here would silently lose
 * `warmupStartedOn` and restart a live domain's warm-up ramp at day one.
 */
async function storedPacing(tx) {
  const rows = await tx.query('SELECT key, value FROM settings');
  const stored = {};
  for (const { key, value } of rows) {
    try {
      stored[key] = JSON.parse(value);
    } catch {
      // A hand-edited row that will not parse: fall through to the preset.
    }
  }
  return stored;
}

function envMailboxIsConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);
}

export async function ensureDefaultMailbox() {
  const marked = await queryOne('SELECT value FROM settings WHERE key = $1', [MARKER]);
  if (marked) return null;

  const existing = await queryOne('SELECT id FROM mailboxes LIMIT 1');
  if (existing) {
    // Mailboxes were added some other way; nothing to seed, but record that
    // the question has been settled so this does not run again.
    await markSeeded();
    return null;
  }

  if (!envMailboxIsConfigured()) {
    log('no SMTP settings in .env - add a mailbox in Settings > Mailboxes');
    return null;
  }

  return transaction(async (tx) => {
    const stored = await storedPacing(tx);

    // IMAP is only carried over if it is actually usable. Enabling it with no
    // password would violate the table's own CHECK, and would be a silent
    // no-op even if it did not.
    const imapUsable = Boolean(env.IMAP_ENABLED && env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASSWORD);

    const mailbox = await tx.queryOne(
      `INSERT INTO mailboxes (
         label, provider, region, from_name, from_email, reply_to,
         sending_domain, dkim_selector,
         smtp_host, smtp_port, smtp_user, smtp_password_cipher,
         imap_enabled, imap_host, imap_port, imap_user, imap_password_cipher,
         imap_poll_seconds,
         daily_cap, hourly_cap, min_interval_seconds, jitter_percent,
         warmup_enabled, warmup_started_on, warmup_schedule,
         is_active, is_default
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18,
         $19, $20, $21, $22,
         $23, $24, $25::jsonb,
         TRUE, TRUE
       )
       RETURNING id, label, from_email`,
      [
        `${env.MAIL_FROM_NAME} (${env.provider.label})`.slice(0, 200),
        env.provider.id,
        env.provider.region ?? null,
        env.MAIL_FROM_NAME,
        env.MAIL_FROM_ADDRESS,
        env.MAIL_REPLY_TO || '',
        env.SENDING_DOMAIN,
        env.DKIM_SELECTOR,

        env.SMTP_HOST,
        env.SMTP_PORT,
        env.SMTP_USER,
        seal(env.SMTP_PASSWORD),

        imapUsable,
        imapUsable ? env.IMAP_HOST : '',
        env.IMAP_PORT,
        imapUsable ? env.IMAP_USER : '',
        imapUsable ? seal(env.IMAP_PASSWORD) : null,
        env.IMAP_POLL_SECONDS,

        stored.dailyCap ?? null,
        stored.hourlyCap ?? null,
        stored.minIntervalSeconds ?? null,
        stored.jitterPercent ?? 60,

        stored.warmupEnabled ?? true,
        stored.warmupStartedOn ?? null,
        // Frozen as stored, so the live ramp keeps the exact shape it has
        // been following rather than being re-derived from the preset.
        JSON.stringify(stored.warmupSchedule ?? null),
      ],
    );

    // --- Backfill ------------------------------------------------------------
    // Everything that was queued, sent or counted before the upgrade belongs
    // to this mailbox, because it was the only one that existed.

    const campaigns = await tx.execute(
      'UPDATE campaigns SET mailbox_id = $1 WHERE mailbox_id IS NULL',
      [mailbox.id],
    );
    const jobs = await tx.execute(
      'UPDATE send_jobs SET mailbox_id = $1 WHERE mailbox_id IS NULL',
      [mailbox.id],
    );
    // Today's count especially: starting it again from zero would let the
    // daily cap be exceeded for the rest of the day.
    const counters = await tx.execute(
      'UPDATE send_counters SET mailbox_id = $1 WHERE mailbox_id IS NULL',
      [mailbox.id],
    );
    // The IMAP read position. Without this the poller re-scans the last week
    // and replays unsubscribes and prediction events that are not idempotent.
    const imap = await tx.execute(
      'UPDATE imap_state SET mailbox_id = $1 WHERE mailbox_id IS NULL',
      [mailbox.id],
    );

    await tx.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [MARKER, JSON.stringify(new Date().toISOString())],
    );

    log(`seeded "${mailbox.label}" <${mailbox.from_email}> from .env`);
    log(`backfilled ${campaigns} campaign(s), ${jobs} job(s), ${counters} counter(s), ${imap} IMAP position(s)`);

    return mailbox;
  });
}

function markSeeded() {
  return execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [MARKER, JSON.stringify(new Date().toISOString())],
  );
}

/** How many mailboxes can send, for the dashboard's empty state. */
export async function activeMailboxCount() {
  const row = await queryOne('SELECT COUNT(*) AS n FROM mailboxes WHERE is_active');
  return row?.n ?? 0;
}
