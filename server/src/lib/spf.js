import { Resolver } from 'node:dns/promises';

/**
 * Recursive SPF evaluation.
 *
 * A flat string match on the root record is not enough in practice. Most
 * domains that send through more than one provider put their senders behind
 * an `include:` (an SPF-management or flattening service), so the provider
 * you are looking for is often one or two levels down. Walking the chain also
 * surfaces the two faults that silently break SPF:
 *
 *  - More than one SPF record on a name: a permanent error, not "extra
 *    coverage" - receivers reject both.
 *  - More than 10 DNS-querying mechanisms across the whole chain (RFC 7208
 *    section 4.6.4): a permerror, so SPF fails even though the record looks
 *    correct.
 */

const resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

export const MAX_LOOKUPS = 10;

async function spfRecordsFor(name) {
  try {
    const all = (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    return all.filter((record) => record.toLowerCase().startsWith('v=spf1'));
  } catch {
    return [];
  }
}

/**
 * Mechanisms that cost a DNS lookup against the limit of 10.
 *
 * The boundary after the name matters: `a` may appear bare, with `:domain`
 * or with a `/cidr`, but it must not swallow `all`. Matching loosely here
 * counts every record's trailing `~all` as an `a` lookup and inflates the
 * total by one per record in the chain.
 */
const LOOKUP_MECHANISMS = /^(?:[+\-~?])?(include:|redirect=|exists:|ptr(?::|$)|a(?=[:/]|$)|mx(?=[:/]|$))(.*)$/i;

/**
 * Walks the include chain from `domain`.
 *
 * @returns {Promise<{
 *   found: boolean, root: string|null, duplicateAt: string[],
 *   lookups: number, includes: string[], ipMechanisms: number,
 *   allMechanism: string|null, chain: object[]
 * }>}
 */
export async function resolveSpf(domain) {
  const result = {
    found: false,
    root: null,
    duplicateAt: [],
    lookups: 0,
    includes: [],
    rootIncludes: [],
    ipMechanisms: 0,
    allMechanism: null,
    chain: [],
  };

  const visited = new Set();

  async function walk(name, depth) {
    // Guards against an include loop, which would otherwise never terminate.
    if (visited.has(name) || depth > 8) return;
    visited.add(name);

    const records = await spfRecordsFor(name);
    if (records.length === 0) return;
    if (records.length > 1) result.duplicateAt.push(name);

    const record = records[0];
    result.chain.push({ name, record, depth });

    if (depth === 0) {
      result.found = true;
      result.root = record;
      result.allMechanism = record.match(/([~\-+?])all\s*(?:$|\s)/)?.[1] ?? null;
    }

    for (const term of record.split(/\s+/)) {
      if (/^(\+|-|~|\?)?ip[46]:/i.test(term)) {
        result.ipMechanisms += 1;
        continue;
      }

      const match = term.match(LOOKUP_MECHANISMS);
      if (!match) continue;

      const mechanism = match[1].toLowerCase().replace(/[:=]$/, '');
      const target = match[2];

      result.lookups += 1;

      if ((mechanism === 'include' || mechanism === 'redirect') && target) {
        result.includes.push(target);
        // Only the root record's includes can be edited directly; anything
        // deeper belongs to a record the operator may not control, and
        // re-stating it at the root would just waste a lookup.
        if (depth === 0) result.rootIncludes.push(target);
        await walk(target.toLowerCase(), depth + 1);
      }
    }
  }

  await walk(domain.toLowerCase(), 0);
  return result;
}

/**
 * True if `provider` is authorised anywhere in the chain, at any depth.
 * `patterns` are matched against each include target.
 */
export function chainAuthorises(spf, patterns) {
  return spf.includes.some((include) =>
    patterns.some((pattern) => pattern.test(include)));
}

export const PROVIDER_PATTERNS = {
  zoho: [/^zoho\.(com|in|eu|com\.au|jp|uk|sa)$/i, /\bzoho\b/i],
  google: [/^_spf\.google\.com$/i, /\bgoogle\.com$/i],
  microsoft: [/^spf\.protection\.outlook\.com$/i],
  brevo: [/\bsendinblue\.com$|\bbrevo\b/i],
  mailchimp: [/\bmcsv\.net$|\bmailchimp\b/i],
  sendgrid: [/\bsendgrid\.net$/i],
  amazonses: [/\bamazonses\.com$/i],
};

const ZOHO_INCLUDE = /^zoho\.(com|in|eu|com\.au|jp|uk|sa)$/i;

/** Zoho regions the chain authorises, e.g. ['zoho.in']. */
export function zohoRegions(spf) {
  return spf.includes.filter((include) => ZOHO_INCLUDE.test(include));
}

/**
 * An include for the wrong Zoho region: mail leaves one data centre while
 * SPF authorises another. Every message fails SPF and nothing in the record
 * itself hints at why, which makes this worth calling out specifically
 * rather than reporting the record as valid.
 *
 * @returns {null | { authorised: string[], expected: string }}
 */
export function zohoRegionMismatch(spf, dataCentre) {
  if (!dataCentre) return null;

  const authorised = zohoRegions(spf);
  if (authorised.length === 0) return null;

  const expected = `zoho.${dataCentre}`.toLowerCase();
  if (authorised.some((region) => region.toLowerCase() === expected)) return null;

  return { authorised, expected };
}

/** Named providers detected anywhere in the chain. */
export function detectProviders(spf) {
  return Object.entries(PROVIDER_PATTERNS)
    .filter(([, patterns]) => chainAuthorises(spf, patterns))
    .map(([name]) => name);
}
