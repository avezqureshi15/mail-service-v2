import nodemailer from 'nodemailer';
import { connectionTargetFor } from '../lib/resolve-host.js';
import { mailboxSecrets } from '../db/repositories/mailboxes.js';

/**
 * One pooled SMTP connection per mailbox, reused for the life of the process.
 *
 * Reconnecting per message is both slow and a bulk-sender signature - a
 * well-behaved client opens one authenticated session and streams through
 * it. The pool is deliberately tiny: each sender loop sends strictly one
 * message at a time, so a second connection would be an idle socket serving
 * nothing, and providers throttle concurrent connections anyway.
 *
 * Async because the host is resolved first: see resolve-host.js for why the
 * machine's own DNS cannot be relied on.
 */

const pools = new Map();

/** Pools dropped by `markTransportStale`, closed once they fall idle. */
const orphans = new Set();

// Closed after this long unused. Without it, N mailboxes would each hold a
// socket open forever - and an idle socket is something providers drop on
// their own schedule, which surfaces as a mysterious failed send later.
const IDLE_MS = 10 * 60_000;
const REAP_EVERY_MS = 60_000;

let reaper = null;

/**
 * The cache key.
 *
 * `config_version` is bumped only when the host, port, user or password
 * changes - deliberately NOT `updated_at`, which also moves when a failed
 * send records `last_error` or a quota response sets `paused_until`. Keying
 * on `updated_at` would tear down a warm authenticated session on every
 * failure, which is exactly when re-authenticating against a provider that is
 * already throttling you is most expensive.
 *
 * The resolved host is in the key too, preserving the original behaviour of
 * rebuilding when the provider moves the address a name points at.
 */
function cacheKey(mailbox, resolvedHost) {
  return `${mailbox.id}:${mailbox.config_version}:${resolvedHost}`;
}

function buildTransport({ host, servername, port, user, pass, pooled = true }) {
  const secure = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS. Anything else must negotiate STARTTLS and is
    // refused if the server will not upgrade - credentials and contact data
    // never travel over a cleartext session.
    secure,
    requireTLS: !secure,
    auth: { user, pass },
    pool: pooled,
    maxConnections: 1,
    // Recycle periodically; providers drop very long sessions.
    maxMessages: 100,
    tls: {
      // Certificate validation stays on, and `servername` is the real
      // hostname even when connecting to an IP - so the certificate is still
      // checked against the name, not the address.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

/** The pooled transport for one mailbox, built on first use. */
export async function getTransport(mailbox) {
  if (!mailbox) throw new Error('getTransport requires a mailbox');

  const target = await connectionTargetFor(mailbox.smtp_host);
  const key = cacheKey(mailbox, target.host);

  const cached = pools.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.transporter;
  }

  // The only place a sending credential is decrypted. The plaintext goes
  // straight into the nodemailer pool, where it has to live anyway, and is
  // never held in the mailbox cache.
  const { smtpPassword } = await mailboxSecrets(mailbox.id);

  const transporter = buildTransport({
    host: target.host,
    servername: target.servername,
    port: mailbox.smtp_port,
    user: mailbox.smtp_user,
    pass: smtpPassword,
  });

  pools.set(key, { transporter, mailboxId: mailbox.id, lastUsed: Date.now() });
  startReaper();

  return transporter;
}

/**
 * Drops a mailbox's pooled connections after its credentials changed.
 *
 * Deliberately does not call `close()`: a pool with a message in flight would
 * abort it. The entry is removed from the map, so the owning loop picks up
 * the new key on its next tick - which by construction is after the current
 * send finished - and the orphaned pool is closed by the reaper.
 */
export function markTransportStale(mailboxId) {
  for (const [key, entry] of pools) {
    if (entry.mailboxId !== Number(mailboxId)) continue;
    pools.delete(key);
    orphans.add(entry);
  }
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;

    for (const [key, entry] of pools) {
      if (entry.lastUsed >= cutoff) continue;
      pools.delete(key);
      try { entry.transporter.close(); } catch { /* already gone */ }
    }

    for (const entry of orphans) {
      if (entry.lastUsed >= cutoff) continue;
      orphans.delete(entry);
      try { entry.transporter.close(); } catch { /* already gone */ }
    }
  }, REAP_EVERY_MS);

  // Must not hold the process open on its own.
  reaper.unref?.();
}

/**
 * Checks a mailbox's credentials without touching the cache.
 *
 * Non-pooled and closed immediately, so a failed "Test connection" in the UI
 * cannot leave a half-open session behind, and a successful one does not
 * install a pool for a mailbox that may not be saved.
 */
export async function verifyTransport(mailbox, { smtpPassword } = {}) {
  const target = await connectionTargetFor(mailbox.smtp_host);
  const pass = smtpPassword ?? (await mailboxSecrets(mailbox.id)).smtpPassword;

  const transporter = buildTransport({
    host: target.host,
    servername: target.servername,
    port: mailbox.smtp_port,
    user: mailbox.smtp_user,
    pass,
    pooled: false,
  });

  try {
    return await transporter.verify();
  } finally {
    try { transporter.close(); } catch { /* nothing to close */ }
  }
}

/**
 * Closes every pool. Mandatory at shutdown, not merely tidy: open sockets
 * keep the event loop alive and turn a clean exit into a hang.
 */
export async function closeAllTransports() {
  for (const [key, entry] of pools) {
    pools.delete(key);
    try { entry.transporter.close(); } catch { /* already gone */ }
  }
  for (const entry of orphans) {
    orphans.delete(entry);
    try { entry.transporter.close(); } catch { /* already gone */ }
  }
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
