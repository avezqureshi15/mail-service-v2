import { query, queryOne, execute } from '../index.js';

/**
 * Cached SPF/DKIM/DMARC results, keyed on the (sending domain, DKIM selector)
 * pair rather than on the domain alone.
 *
 * The pair matters because two mailboxes can share a sending domain and still
 * need different answers: a Google mailbox publishes DKIM under selector
 * `google` and needs include:_spf.google.com, while a Zoho mailbox on the
 * very same domain wants `zoho` and include:zoho.com. Keyed on the domain
 * only, whichever mailbox happened to check last would decide whether the
 * other one was allowed to send.
 */

export function readDomainHealth(sendingDomain, dkimSelector) {
  return queryOne(
    'SELECT * FROM domain_health WHERE sending_domain = $1 AND dkim_selector = $2',
    [sendingDomain, dkimSelector],
  );
}

/** Most recently checked pair - what the dashboard shows when unqualified. */
export function latestDomainHealth() {
  return queryOne('SELECT * FROM domain_health ORDER BY checked_at DESC NULLS LAST LIMIT 1');
}

export function allDomainHealth() {
  return query('SELECT * FROM domain_health ORDER BY sending_domain, dkim_selector');
}

export function recordDomainHealth(sendingDomain, dkimSelector, result) {
  return execute(
    `INSERT INTO domain_health (sending_domain, dkim_selector, spf_ok, dkim_ok, dmarc_ok, detail, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
     ON CONFLICT (sending_domain, dkim_selector) DO UPDATE SET
       spf_ok = excluded.spf_ok, dkim_ok = excluded.dkim_ok, dmarc_ok = excluded.dmarc_ok,
       detail = excluded.detail, checked_at = excluded.checked_at`,
    [
      sendingDomain,
      dkimSelector,
      result.spf.ok,
      result.dkim.ok,
      result.dmarc.ok,
      JSON.stringify(result),
    ],
  );
}
