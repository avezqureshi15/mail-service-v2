import { transaction } from '../db/index.js';
import { normaliseEmail } from '../db/repositories/suppressions.js';

/**
 * Records an opt-out, whatever route it arrived by.
 *
 * Shared between the web endpoint (a click, or an RFC 8058 one-click POST)
 * and the inbox poller (the `mailto:` option in the same List-Unsubscribe
 * header), so every method produces identical results - suppression, contact
 * status, sequence exit and an audit row.
 *
 * All of it happens in one transaction: a partial unsubscribe that suppressed
 * the address but left the contact enrolled would keep mailing someone who
 * just asked us to stop.
 *
 * The contact and campaign ids are treated as hints, not facts. They are
 * resolved against the database and dropped if they do not match a real row:
 * a token can outlive the campaign it was minted for, and test sends mint
 * tokens for ids that never existed. Writing an id with no matching row trips
 * a foreign key and fails the whole request - which means a recipient
 * clicking Unsubscribe gets an error page and reaches for the spam button
 * instead. Suppressing the address is what matters; the ids are provenance.
 */
export function applyUnsubscribe({
  email, contactId = null, campaignId = null, method = 'link', ip = '', userAgent = '', tenantId = 1,
}) {
  const normalised = normaliseEmail(email);

  return transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO suppressions (tenant_id, email, reason, source)
       VALUES ($1, $2, 'unsubscribed', $3)
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
      [tenantId, normalised, method],
    );

    await tx.execute(
      'UPDATE contacts SET status = $1, updated_at = now() WHERE tenant_id = $2 AND lower(email) = $3',
      ['unsubscribed', tenantId, normalised],
    );

    // Prefer the id in the token, but only once it is known to exist; fall
    // back to looking the address up.
    const claimed = Number.isInteger(contactId) && contactId > 0
      ? await tx.queryOne('SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2', [contactId, tenantId])
      : null;
    const contact = claimed ?? await tx.queryOne(
      'SELECT id FROM contacts WHERE tenant_id = $1 AND lower(email) = $2',
      [tenantId, normalised],
    );

    const campaign = Number.isInteger(campaignId) && campaignId > 0
      ? await tx.queryOne('SELECT id FROM campaigns WHERE id = $1 AND tenant_id = $2', [campaignId, tenantId])
      : null;

    await tx.execute(
      `INSERT INTO unsubscribes (contact_id, campaign_id, email, method, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [contact?.id ?? null, campaign?.id ?? null, normalised, method, ip, userAgent],
    );

    // Out of every active sequence, not just the one that prompted this.
    if (contact?.id) {
      await tx.execute(
        `UPDATE sequence_enrollments
            SET status = 'exited', exit_reason = 'unsubscribed', next_run_at = NULL, updated_at = now()
          WHERE contact_id = $1 AND status = 'active'`,
        [contact.id],
      );
    }

    return { email: normalised, contactId: contact?.id ?? null };
  });
}
