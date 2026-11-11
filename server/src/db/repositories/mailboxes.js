import { query, queryOne, execute } from '../index.js';
import { open } from '../../lib/secret-box.js';
import { resolveProvider, pacingDefaults } from '../../config/providers.js';
import { asDayString } from '../../lib/warmup.js';

/**
 * The sending mailboxes.
 *
 * Shaped deliberately like the settings repository: read once into memory at
 * boot, re-read after every write, and exposed through *synchronous* getters.
 * The sender loop asks which mailbox it is working for on every tick, and a
 * network round trip per tick per mailbox would be wasteful now the database
 * is remote.
 *
 * Two rules hold this module together:
 *
 *  1. The cache NEVER holds a decrypted password. `open()` is called only in
 *     `mailboxSecrets()`, which the transport and IMAP factories call at the
 *     moment they build a connection. Every other consumer physically cannot
 *     leak a credential because the cached object does not contain one.
 *
 *  2. Everything that leaves this module for an HTTP response goes through
 *     `toPublicMailbox()`, so a stray `res.json(row)` cannot ship ciphertext
 *     either.
 */

const SECRET_COLUMNS = ['smtp_password_cipher', 'imap_password_cipher'];

/** id -> cached mailbox, including resolved pacing. Never holds plaintext. */
let cache = new Map();

export function invalidateMailboxCache() {
  cache = new Map();
}

/**
 * Effective pacing for a mailbox.
 *
 * A NULL column means "follow the provider preset", so a mailbox that has
 * never been tuned tracks providers.js rather than carrying a number copied
 * at creation that quietly goes stale when the preset is corrected.
 *
 * The warm-up schedule is the exception: it is stored, not derived. The ramp
 * is anchored by warmup_started_on, so re-deriving it mid-ramp from a changed
 * preset would step the allowance up - the one thing warm-up exists to avoid.
 */
function resolvePacing(row) {
  const preset = resolveProvider(row.provider, row.smtp_host);
  const defaults = pacingDefaults(preset);

  return {
    dailyCap: row.daily_cap ?? defaults.dailyCap,
    hourlyCap: row.hourly_cap ?? defaults.hourlyCap,
    minIntervalSeconds: row.min_interval_seconds ?? defaults.minIntervalSeconds,
    jitterPercent: row.jitter_percent,
    warmupEnabled: row.warmup_enabled,
    warmupStartedOn: asDayString(row.warmup_started_on),
    warmupSchedule: row.warmup_schedule ?? defaults.warmupSchedule,
  };
}

/** Decorates a raw row with its provider preset and effective pacing. */
function decorate(row) {
  return {
    ...row,
    warmup_started_on: asDayString(row.warmup_started_on),
    preset: resolveProvider(row.provider, row.smtp_host),
    pacing: resolvePacing(row),
  };
}

export async function loadMailboxes() {
  const rows = await query('SELECT * FROM mailboxes ORDER BY id');
  const next = new Map();
  for (const row of rows) next.set(row.id, decorate(row));
  cache = next;
  return [...cache.values()];
}

/** Synchronous: reads the cache populated by `loadMailboxes()`. */
export function getMailbox(id) {
  return cache.get(Number(id)) ?? null;
}

export function allMailboxes() {
  return [...cache.values()];
}

/**
 * Mailboxes the sender may work for right now.
 *
 * `paused_until` is how a provider quota error parks one mailbox without
 * touching the others, and it heals itself at expiry rather than needing a
 * human to restart a campaign.
 */
export function activeMailboxes() {
  const now = Date.now();
  return [...cache.values()].filter((m) => (
    m.is_active && !(m.paused_until && new Date(m.paused_until).getTime() > now)
  ));
}

export function defaultMailbox() {
  return [...cache.values()].find((m) => m.is_default) ?? null;
}

/** Distinct sending domains, for the inbox poller's Message-ID pre-filter. */
export function sendingDomains() {
  return [...new Set([...cache.values()].map((m) => m.sending_domain).filter(Boolean))];
}

/**
 * Decrypts a mailbox's credentials. The ONLY place `open()` is called.
 *
 * Reads straight from the database rather than the cache, so the ciphertext
 * never has to be held in memory between writes.
 */
export async function mailboxSecrets(id) {
  const row = await queryOne(
    'SELECT smtp_password_cipher, imap_password_cipher FROM mailboxes WHERE id = $1',
    [Number(id)],
  );
  if (!row) throw new Error(`Mailbox ${id} no longer exists`);

  return {
    smtpPassword: open(row.smtp_password_cipher),
    imapPassword: row.imap_password_cipher ? open(row.imap_password_cipher) : null,
  };
}

/**
 * The shape that may leave the server. Strips the sealed columns outright
 * rather than relying on every call site to remember.
 */
export function toPublicMailbox(mailbox) {
  if (!mailbox) return null;
  const safe = { ...mailbox };
  for (const column of SECRET_COLUMNS) delete safe[column];

  return {
    ...safe,
    hasSmtpPassword: Boolean(mailbox.smtp_password_cipher),
    hasImapPassword: Boolean(mailbox.imap_password_cipher),
  };
}

/**
 * Parks a mailbox for a while after the provider refused a send.
 *
 * Deliberately bumps `updated_at` but NOT `config_version`: the credentials
 * have not changed, so the pooled SMTP connection should survive. Rebuilding
 * it here would force a re-authentication against a provider that has just
 * told us to slow down.
 */
export async function pauseMailbox(id, { minutes, reason }) {
  await execute(
    `UPDATE mailboxes
        SET paused_until = now() + make_interval(mins => $1),
            pause_reason = $2,
            updated_at   = now()
      WHERE id = $3`,
    [minutes, String(reason ?? '').slice(0, 500), Number(id)],
  );
  return loadMailboxes();
}

export async function recordMailboxError(id, message) {
  await execute(
    'UPDATE mailboxes SET last_error = $1, updated_at = now() WHERE id = $2',
    [message ? String(message).slice(0, 1000) : null, Number(id)],
  );
  return loadMailboxes();
}

/**
 * Total allowance across active mailboxes on one sending domain.
 *
 * Four mailboxes at 300/day is 1,200/day from a single domain's reputation -
 * exactly the volume warm-up exists to prevent, and nothing else in the
 * system would notice. Surfaced as a warning in the Mailboxes tab.
 */
export function domainDailyLoad() {
  const totals = new Map();
  for (const mailbox of activeMailboxes()) {
    const current = totals.get(mailbox.sending_domain) ?? 0;
    totals.set(mailbox.sending_domain, current + mailbox.pacing.dailyCap);
  }
  return [...totals].map(([domain, dailyCap]) => ({ domain, dailyCap }));
}

// --- Writes ----------------------------------------------------------------

/**
 * Columns whose change invalidates a pooled SMTP connection.
 *
 * Only these bump `config_version`. Everything else - a recorded error, a
 * quota pause, a renamed label - leaves the warm authenticated session alone.
 */
const CONNECTION_COLUMNS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password_cipher'];

const WRITABLE = new Set([
  'label', 'provider', 'region', 'from_name', 'from_email', 'reply_to',
  'sending_domain', 'dkim_selector',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_password_cipher',
  'imap_enabled', 'imap_host', 'imap_port', 'imap_user', 'imap_password_cipher',
  'imap_poll_seconds',
  'daily_cap', 'hourly_cap', 'min_interval_seconds', 'jitter_percent',
  'warmup_enabled', 'warmup_started_on', 'warmup_schedule',
  'is_active', 'is_default', 'paused_until', 'pause_reason',
  'last_verified_at', 'last_verify_error', 'last_error',
]);

export async function createMailbox(values, createdBy = null) {
  const columns = Object.keys(values).filter((key) => WRITABLE.has(key));
  const placeholders = columns.map((_, i) => `$${i + 1}`);

  const row = await queryOne(
    `INSERT INTO mailboxes (${columns.join(', ')}, created_by)
     VALUES (${placeholders.join(', ')}, $${columns.length + 1})
     RETURNING *`,
    [...columns.map((key) => values[key]), createdBy],
  );

  if (row.is_default) await clearOtherDefaults(row.id);
  await loadMailboxes();
  return getMailbox(row.id);
}

export async function updateMailbox(id, patch) {
  const columns = Object.keys(patch).filter((key) => WRITABLE.has(key));
  if (columns.length === 0) return getMailbox(id);

  // Column names come from the allowlist above, never from caller input;
  // every value stays parameterized.
  const assignments = columns.map((key, i) => `${key} = $${i + 1}`);

  // Credentials changed, so any pooled connection is now authenticating with
  // the wrong password and has to be rebuilt.
  const touchesConnection = columns.some((key) => CONNECTION_COLUMNS.includes(key));
  if (touchesConnection) assignments.push('config_version = config_version + 1');

  await execute(
    `UPDATE mailboxes SET ${assignments.join(', ')}, updated_at = now()
      WHERE id = $${columns.length + 1}`,
    [...columns.map((key) => patch[key]), Number(id)],
  );

  if (patch.is_default) await clearOtherDefaults(id);
  await loadMailboxes();
  return getMailbox(id);
}

/**
 * The partial unique index allows only one default per tenant, so the old one
 * has to be cleared before the new one lands - otherwise the write fails on a
 * constraint the operator never set.
 */
function clearOtherDefaults(keepId) {
  return execute(
    'UPDATE mailboxes SET is_default = FALSE, updated_at = now() WHERE id <> $1 AND is_default',
    [Number(keepId)],
  );
}

export async function recordVerification(id, { ok, error = null }) {
  await execute(
    `UPDATE mailboxes
        SET last_verified_at  = CASE WHEN $1 THEN now() ELSE last_verified_at END,
            last_verify_error = $2,
            updated_at        = now()
      WHERE id = $3`,
    [ok, ok ? null : String(error ?? '').slice(0, 1000), Number(id)],
  );
  return loadMailboxes();
}

/** How many campaigns would be orphaned by removing this mailbox. */
export async function campaignsUsingMailbox(id) {
  const row = await queryOne(
    'SELECT COUNT(*) AS n FROM campaigns WHERE mailbox_id = $1',
    [Number(id)],
  );
  return row?.n ?? 0;
}

export async function removeMailbox(id) {
  await execute('DELETE FROM mailboxes WHERE id = $1', [Number(id)]);
  return loadMailboxes();
}
