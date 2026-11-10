import tls from 'node:tls';
import net from 'node:net';
import { Resolver } from 'node:dns/promises';

/**
 * Connectivity preflight, deliberately without authentication.
 *
 * Run before credentials exist, it answers "is the host right and the path
 * open" separately from "is the password right". Without that split, a
 * firewall blocking port 465 and a mistyped app password produce the same
 * unhelpful failure.
 */

const resolver = new Resolver({ timeout: 5000 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

export async function resolveHost(host) {
  try {
    const addresses = await resolver.resolve4(host);
    return { ok: addresses.length > 0, addresses };
  } catch (error) {
    return { ok: false, addresses: [], error: error.code ?? error.message };
  }
}

/**
 * Opens the socket, completes the TLS handshake on an implicit-TLS port, and
 * reads the server greeting. Never sends credentials.
 */
/** A healthy server opens with these: SMTP says 220, IMAP says "* OK". */
export const GREETING = {
  smtp: /^220[\s-]/,
  imap: /^\*\s+OK/i,
};

export function probe(host, port, { timeout = 10_000, implicitTls = true, protocol = 'smtp' } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve({ ...result, ms: Date.now() - started });
    };

    const onGreeting = (data) => {
      const greeting = data.toString().trim().split('\n')[0];
      const expected = GREETING[protocol] ?? GREETING.smtp;
      finish({
        ok: expected.test(greeting),
        greeting,
        tls: implicitTls ? tlsInfo() : null,
      });
    };

    const tlsInfo = () => {
      if (typeof socket.getProtocol !== 'function') return null;
      const cipher = socket.getCipher?.() ?? {};
      const cert = socket.getPeerCertificate?.() ?? {};
      return {
        protocol: socket.getProtocol(),
        cipher: cipher.name ?? null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError
          ? String(socket.authorizationError)
          : null,
        subject: cert.subject?.CN ?? null,
        validTo: cert.valid_to ?? null,
      };
    };

    const socket = implicitTls
      ? tls.connect({
        host,
        port,
        servername: host,
        // Report a bad certificate rather than refusing to connect, so the
        // probe can explain what is wrong instead of just failing.
        rejectUnauthorized: false,
        timeout,
      })
      : net.connect({ host, port, timeout });

    socket.once(implicitTls ? 'secureConnect' : 'connect', () => {
      socket.once('data', onGreeting);
    });

    socket.once('timeout', () => finish({
      ok: false,
      error: `timed out after ${timeout}ms - port ${port} is most likely blocked by a firewall`,
    }));

    socket.once('error', (error) => finish({
      ok: false,
      error: `${error.code ?? ''} ${error.message}`.trim(),
    }));
  });
}
