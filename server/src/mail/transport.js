import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { connectionTargetFor } from '../lib/resolve-host.js';

let transporter = null;
let builtFor = null;

/**
 * A single pooled connection, reused for the life of the process.
 *
 * Reconnecting per message is both slow and a bulk-sender signature - a
 * well-behaved client opens one authenticated session and streams through
 * it. The pool is deliberately small: providers throttle concurrent
 * connections, and at these volumes one or two is plenty.
 *
 * Async because the host is resolved first: see resolve-host.js for why the
 * machine's own DNS cannot be relied on.
 */
export async function getTransport() {
  const target = await connectionTargetFor(env.SMTP_HOST);

  // Rebuild if the resolved address changed, so a cached pool does not keep
  // pointing at an address the provider has moved away from.
  if (transporter && builtFor === target.host) return transporter;
  if (transporter) transporter.close();

  transporter = nodemailer.createTransport({
    host: target.host,
    port: env.SMTP_PORT,
    // 465 is implicit TLS. Anything else must negotiate STARTTLS and is
    // refused if the server will not upgrade - credentials and contact data
    // never travel over a cleartext session.
    secure: env.smtpSecure,
    requireTLS: !env.smtpSecure,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
    pool: true,
    maxConnections: 2,
    // Recycle periodically; providers drop very long sessions.
    maxMessages: 100,
    tls: {
      // Certificate validation stays on, and `servername` is the real
      // hostname even when connecting to an IP - so the certificate is still
      // checked against the name, not the address.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername: target.servername,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });

  builtFor = target.host;
  return transporter;
}

export async function verifyTransport() {
  const t = await getTransport();
  return t.verify();
}

export async function closeTransport() {
  if (transporter) {
    transporter.close();
    transporter = null;
    builtFor = null;
  }
}
