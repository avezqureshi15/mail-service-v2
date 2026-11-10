import { hasMx } from './dns-check.js';

/**
 * Import-time list hygiene.
 *
 * Bad addresses are what destroy sender reputation, so they are filtered
 * before the first send rather than discovered as a bounce storm afterwards.
 */

// Addresses answered by a team rather than a person. They produce
// disproportionate complaint rates and rarely convert on cold outreach.
const ROLE_PREFIXES = new Set([
  'abuse', 'admin', 'administrator', 'all', 'billing', 'careers', 'compliance',
  'contact', 'enquiries', 'enquiry', 'everyone', 'feedback', 'finance',
  'help', 'hello', 'hi', 'hr', 'info', 'inquiries', 'investors', 'jobs',
  'legal', 'mail', 'marketing', 'media', 'newsletter', 'no-reply', 'noreply',
  'office', 'orders', 'postmaster', 'press', 'privacy', 'recruitment',
  'sales', 'security', 'shop', 'signup', 'subscribe', 'support', 'team',
  'unsubscribe', 'webmaster', 'welcome',
]);

// Throwaway inbox providers - never a real prospect.
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com',
  'sharklasers.com', 'grr.la', 'spam4.me', 'mohmal.com', 'emailondeck.com',
]);

// Deliberately pragmatic rather than RFC-complete: the full grammar accepts
// addresses no mail server will deliver to.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function parseEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'empty' };
  if (email.length > 254) return { ok: false, reason: 'too_long' };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, reason: 'malformed' };

  const [local, domain] = email.split('@');
  if (local.length > 64) return { ok: false, reason: 'local_too_long' };

  return {
    ok: true,
    email,
    local,
    domain,
    isRole: ROLE_PREFIXES.has(local) || ROLE_PREFIXES.has(local.split(/[._-]/)[0]),
    isDisposable: DISPOSABLE_DOMAINS.has(domain),
  };
}

/**
 * Resolves MX once per domain rather than once per address, and caches the
 * answer for the life of the import.
 */
export function createMxChecker() {
  const cache = new Map();

  return async function checkMx(domain) {
    if (cache.has(domain)) return cache.get(domain);

    const promise = hasMx(domain)
      .then((ok) => ({ ok, inconclusive: false }))
      // A timeout should not reject a good address - treat it as unknown and
      // let the bounce handler deal with it if it really is dead.
      .catch(() => ({ ok: true, inconclusive: true }));

    cache.set(domain, promise);
    return promise;
  };
}

/**
 * @returns {Promise<{accepted: object[], flagged: object[], rejected: object[]}>}
 */
export async function validateRows(rows, { excludeRoleAccounts = true, checkMx = true } = {}) {
  const accepted = [];
  const flagged = [];
  const rejected = [];
  const seen = new Set();
  const mx = createMxChecker();

  // Validate domains concurrently but in bounded batches, so a large import
  // does not open thousands of simultaneous DNS queries.
  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    const results = await Promise.all(batch.map(async (row) => {
      // Everything up to the first await runs synchronously as each callback
      // is invoked, so claiming the address in `seen` here catches duplicates
      // *within* a batch too. Deferring it until the batch resolved would let
      // every copy of an address pass at once.
      const parsed = parseEmail(row.email);

      if (!parsed.ok) {
        return { bucket: 'rejected', row, reason: parsed.reason };
      }
      if (seen.has(parsed.email)) {
        return { bucket: 'rejected', row, reason: 'duplicate_in_file', email: parsed.email };
      }
      seen.add(parsed.email);

      if (parsed.isDisposable) {
        return { bucket: 'rejected', row, reason: 'disposable_domain', email: parsed.email };
      }

      if (checkMx) {
        const { ok, inconclusive } = await mx(parsed.domain);
        if (!ok) {
          return { bucket: 'rejected', row, reason: 'no_mx_record', email: parsed.email };
        }
        if (inconclusive) {
          return { bucket: 'flagged', row, reason: 'mx_lookup_timed_out', email: parsed.email, parsed };
        }
      }

      if (parsed.isRole) {
        return {
          bucket: excludeRoleAccounts ? 'flagged' : 'accepted',
          row,
          reason: 'role_account',
          email: parsed.email,
          parsed,
        };
      }

      return { bucket: 'accepted', row, email: parsed.email, parsed };
    }));

    for (const result of results) {
      const entry = {
        // Rejected rows keep whatever raw value was in the file, so the
        // report can show the operator which line to fix.
        email: result.email ?? String(result.row?.email ?? ''),
        reason: result.reason ?? null,
        row: result.row,
        parsed: result.parsed ?? null,
      };
      if (result.bucket === 'accepted') accepted.push(entry);
      else if (result.bucket === 'flagged') flagged.push(entry);
      else rejected.push(entry);
    }
  }

  return { accepted, flagged, rejected };
}

export const REASON_LABELS = {
  empty: 'No email address in the row',
  too_long: 'Address exceeds 254 characters',
  malformed: 'Not a valid email address',
  local_too_long: 'Part before the @ is too long',
  duplicate_in_file: 'Duplicate of an earlier row',
  disposable_domain: 'Throwaway / disposable mailbox provider',
  no_mx_record: 'Domain has no mail server - this address would hard bounce',
  mx_lookup_timed_out: 'Could not confirm the domain accepts mail',
  role_account: 'Shared mailbox (info@, sales@, support@ and similar)',
  already_suppressed: 'Previously unsubscribed or bounced',
};
