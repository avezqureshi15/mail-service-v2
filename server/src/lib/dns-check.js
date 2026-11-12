import { Resolver } from 'node:dns/promises';
import {
  resolveSpf, detectProviders, chainAuthorises, zohoRegions, zohoRegionMismatch,
  PROVIDER_PATTERNS, MAX_LOOKUPS,
} from './spf.js';

// Public resolvers rather than the host's, so a split-horizon corporate DNS
// does not report records the outside world cannot see.
const resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

async function txtRecords(name) {
  try {
    // Node returns each record as an array of strings; long records are split
    // into 255-byte chunks that must be rejoined with no separator.
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') return [];
    throw error;
  }
}

function check(ok, summary, detail = '') {
  return { ok, summary, detail };
}

/**
 * SPF, evaluated across the whole include chain.
 *
 * The provider is frequently nested inside an SPF-management include rather
 * than named on the root record, so a flat string match gives false failures
 * on any domain that sends through more than one service.
 */
export async function checkSpf(domain, { provider = null, dataCentre = null } = {}) {
  const spf = await resolveSpf(domain);

  // The include this provider requires. Falls back to the Zoho region form
  // for callers that still pass a bare data centre.
  const required = provider?.spfInclude ?? (dataCentre ? `zoho.${dataCentre}` : null);
  const providerName = provider?.label ?? 'your sending provider';

  if (!spf.found) {
    return check(false, 'No SPF record found',
      required
        ? `Add a TXT record on ${domain}: "v=spf1 include:${required} ~all"`
        : `Add a TXT record on ${domain} authorising your provider, ending in ~all.`);
  }

  // Two SPF records on one name is a permanent error at the receiver - it is
  // not extra coverage, it invalidates both.
  if (spf.duplicateAt.length > 0) {
    return check(false, `More than one SPF record on ${spf.duplicateAt.join(', ')}`,
      'Receivers treat this as a permanent error and SPF fails outright. Merge them into a single record.');
  }

  // Over 10 DNS-querying mechanisms is a permerror, even though the record
  // reads correctly - a classic failure when providers accumulate.
  if (spf.lookups > MAX_LOOKUPS) {
    return check(false, `SPF uses ${spf.lookups} DNS lookups, over the limit of ${MAX_LOOKUPS}`,
      `This is a permanent error and SPF fails. Flatten or remove unused includes.\nChain: ${spf.includes.join(', ')}`);
  }

  if (!spf.allMechanism) {
    return check(false, 'SPF has no "all" mechanism',
      `Current record: ${spf.root}\nEnd the record with ~all (softfail) or -all (fail).`);
  }
  if (spf.allMechanism === '+') {
    return check(false, 'SPF ends with +all, which authorises every sender on the internet',
      `Current record: ${spf.root}\nChange +all to ~all or -all.`);
  }

  const detected = detectProviders(spf);
  const others = detected.filter((p) => p !== provider?.id);
  const alsoLine = others.length > 0
    ? `\nAlso authorised: ${others.join(', ')} - leave these in place.`
    : '';

  // Nothing to verify against for a provider with no known include.
  if (!required) {
    return check(true,
      `SPF present (${spf.allMechanism}all, ${spf.lookups}/${MAX_LOOKUPS} lookups)`,
      `${spf.root}\nSet MAIL_PROVIDER so the required include can be verified.`);
  }

  const authorised = chainAuthorises(spf, [new RegExp(`^${escapeRegex(required)}$`, 'i')])
    || (provider?.id && chainAuthorises(spf, PROVIDER_PATTERNS[provider.id] ?? []));

  if (!authorised) {
    return check(false, `SPF does not authorise ${providerName}`,
      `Current record: ${spf.root}\n`
      + `ADD the include to the existing record - do not replace it:\n`
      + `  v=spf1 ${spf.rootIncludes.map((i) => `include:${i}`).join(' ')} include:${required} ${spf.allMechanism}all\n`
      + `Uses ${spf.lookups + 1} of ${MAX_LOOKUPS} DNS lookups after the change.${alsoLine}`);
  }

  // Zoho's regional includes are interchangeable to a pattern match but not
  // to a receiver: an include for the wrong region authenticates nothing.
  const mismatch = zohoRegionMismatch(spf, provider?.region ?? dataCentre);
  if (mismatch) {
    return check(false,
      `SPF authorises ${mismatch.authorised.join(', ')} but this service sends via ${mismatch.expected}`,
      `Current record: ${spf.root}\n`
      + `The data centre in SPF must match SMTP_HOST. As it stands every message fails\n`
      + `SPF even though the record looks correct.\n`
      + `Either change the include to "include:${mismatch.expected}", or point SMTP_HOST at\n`
      + `the data centre your account is really in.${alsoLine}`);
  }

  return check(true,
    `SPF valid (${spf.allMechanism}all, ${spf.lookups}/${MAX_LOOKUPS} lookups, authorises ${providerName})`,
    `${spf.root}${alsoLine}`);
}

/**
 * DKIM: the selector published by Zoho must resolve and carry a public key.
 */
/**
 * Selectors worth looking under when the configured one finds nothing.
 *
 * The selector is chosen by whoever set DKIM up - Zoho's own documentation
 * calls it "any string of your convenience" - so a missing record far more
 * often means the wrong name than a missing key. Checking the usual ones
 * turns a dead end into a one-field correction.
 */
const COMMON_SELECTORS = [
  'zoho', 'zmail', 'google', 'default', 'dkim', 'mail', 'email',
  's1', 's2', 'selector1', 'selector2', 'k1', 'key1',
];

/** Looks for a key published under some other selector on the same domain. */
async function findPublishedSelector(domain, configured) {
  const candidates = COMMON_SELECTORS.filter((s) => s !== configured);

  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      const found = await txtRecords(`${candidate}._domainkey.${domain}`);
      return found.some((r) => /p=[A-Za-z0-9+/=]+/.test(r)) ? candidate : null;
    } catch {
      return null;
    }
  }));

  return results.find(Boolean) ?? null;
}

export async function checkDkim(domain, selector) {
  const name = `${selector}._domainkey.${domain}`;
  const records = await txtRecords(name);

  if (records.length === 0) {
    // Before telling anyone to go and generate a key, check whether one is
    // already published under a different name.
    const elsewhere = await findPublishedSelector(domain, selector);

    if (elsewhere) {
      return check(
        false,
        `No DKIM record at ${name} - but a key is published under "${elsewhere}"`,
        `DKIM is set up on ${domain}; this mailbox is just looking under the wrong `
        + `selector. Change its DKIM selector from "${selector}" to "${elsewhere}" and `
        + 're-run the check. No DNS change is needed.',
      );
    }

    return check(false, `No DKIM record at ${name}`, `Enable DKIM in the Zoho Mail admin console (Email Authentication > DKIM), then publish the TXT record it generates at ${name}. The selector there must match the one set on this mailbox.`);
  }

  const record = records.find((r) => /p=/.test(r)) ?? records[0];
  const keyMatch = record.match(/p=([A-Za-z0-9+/=]*)/);

  if (!keyMatch || keyMatch[1].length === 0) {
    return check(false, 'DKIM record present but the public key is empty', `A revoked or placeholder key at ${name}: ${record}`);
  }
  // Rough base64 -> bit estimate. A 1024-bit key is accepted but weak.
  const approxBits = Math.round((keyMatch[1].length * 3) / 4 / 1.2) * 8;
  if (approxBits < 1500) {
    return check(true, 'DKIM valid (key looks like 1024-bit - prefer 2048)', `${name}\nRegenerate as 2048-bit in the Zoho admin console when convenient.`);
  }

  return check(true, 'DKIM valid', name);
}

/**
 * DMARC: must exist with a policy. p=none is acceptable to start but is
 * reported as a warning, since it enforces nothing.
 */
export async function checkDmarc(domain) {
  const name = `_dmarc.${domain}`;
  const records = (await txtRecords(name)).filter((r) => r.toLowerCase().startsWith('v=dmarc1'));

  if (records.length === 0) {
    return check(false, 'No DMARC record found', `Add a TXT record at ${name}: "v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}". Start at p=none, read the reports, then tighten to quarantine and finally reject.`);
  }
  if (records.length > 1) {
    return check(false, `${records.length} DMARC records found - must be exactly one`, records.join('\n'));
  }

  const record = records[0];
  const policy = record.match(/\bp=(none|quarantine|reject)\b/i)?.[1]?.toLowerCase();
  if (!policy) {
    return check(false, 'DMARC record has no p= policy tag', record);
  }

  const hasReporting = /\brua=/i.test(record);
  if (policy === 'none') {
    return check(true, 'DMARC present (p=none - monitoring only)', `${record}\n${hasReporting ? 'Reports are being collected. Move to p=quarantine once they look clean.' : 'No rua= address, so you are not receiving reports. Add one.'}`);
  }

  return check(true, `DMARC enforcing (p=${policy})`, record);
}

/**
 * Receiving domain must have an MX record. Used both by the domain health
 * panel and by contact import, where a domain with no MX is a guaranteed
 * bounce and is rejected before it can hurt the sending reputation.
 */
export async function hasMx(domain) {
  try {
    const records = await resolver.resolveMx(domain);
    return records.length > 0;
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') return false;
    // Treat a timeout as inconclusive rather than rejecting a good address.
    throw error;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function checkDomain(domain, dkimSelector, { provider = null, dataCentre = null } = {}) {
  const settled = await Promise.allSettled([
    checkSpf(domain, { provider, dataCentre }),
    checkDkim(domain, dkimSelector),
    checkDmarc(domain),
  ]);

  const [spf, dkim, dmarc] = settled.map((outcome) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : check(false, 'DNS lookup failed', outcome.reason?.message ?? String(outcome.reason)),
  );

  return {
    domain,
    spf,
    dkim,
    dmarc,
    // DKIM and SPF are what receivers check on every message; DMARC failing
    // is serious but does not by itself stop mail being authenticated.
    passing: spf.ok && dkim.ok,
    checkedAt: new Date().toISOString(),
  };
}
