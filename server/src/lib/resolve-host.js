import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';

/**
 * Resolves a hostname, falling back to public DNS when the machine's own
 * resolver will not answer.
 *
 * A host configured to resolve through something on localhost - a VPN
 * client, a container DNS proxy, a filtering daemon - loses all name
 * resolution the moment that process stops, and the mail service stops
 * sending with an opaque EDNS timeout. The provider is reachable; only the
 * lookup is broken. Falling back keeps mail flowing through that.
 *
 * The system resolver is tried first, so a correctly configured machine
 * behaves exactly as before and nothing is routed around unnecessarily.
 */

// Well-known public resolvers, used only when the local one fails.
const FALLBACK_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

const fallback = new Resolver({ timeout: 4000, tries: 2 });
fallback.setServers(FALLBACK_SERVERS);

const system = new Resolver({ timeout: 4000, tries: 1 });

// Short-lived cache. Long enough to avoid a lookup per message, short enough
// that a provider moving an address is picked up within the hour.
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export function clearHostCache() {
  cache.clear();
}

async function lookupVia(resolver, hostname) {
  const addresses = await resolver.resolve4(hostname);
  if (!addresses?.length) throw new Error(`No A record for ${hostname}`);
  return addresses[0];
}

/**
 * @returns {Promise<{address: string, viaFallback: boolean}>}
 */
export async function resolveHost(hostname) {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value;
  try {
    value = { address: await lookupVia(system, hostname), viaFallback: false };
  } catch (systemError) {
    try {
      value = { address: await lookupVia(fallback, hostname), viaFallback: true };
      console.warn(
        `[dns] ${hostname} could not be resolved by this machine (${systemError.code ?? systemError.message})`
        + ` - used ${FALLBACK_SERVERS[0]} instead. Local DNS is ${dns.getServers().join(', ')}.`,
      );
    } catch {
      // Report the original failure: the local resolver is the real problem.
      throw systemError;
    }
  }

  cache.set(hostname, { value, expires: Date.now() + TTL_MS });
  return value;
}

/**
 * Connection options for a TLS client that survive a broken local resolver.
 *
 * When the fallback was needed the connection is made to the IP directly,
 * with `servername` set to the original hostname. That keeps SNI correct and
 * keeps certificate validation checking the name rather than the address -
 * connecting by IP without it would either fail verification or, if
 * verification were relaxed to compensate, silently accept any certificate.
 */
export async function connectionTargetFor(hostname) {
  const { address, viaFallback } = await resolveHost(hostname);

  return viaFallback
    ? { host: address, servername: hostname, viaFallback: true }
    : { host: hostname, servername: hostname, viaFallback: false };
}
