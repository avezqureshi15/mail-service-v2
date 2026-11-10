import { query, queryOne, execute } from '../index.js';

/**
 * The suppression list is the single authority on whether an address may be
 * mailed. It is global (not per campaign) and permanent - re-subscribing
 * requires an explicit opt-in action, never an import.
 */

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export async function suppress({ email, reason, source = '', notes = '', tenantId = 1 }) {
  const normalised = normaliseEmail(email);
  if (!normalised) return false;

  const changed = await execute(
    `INSERT INTO suppressions (tenant_id, email, reason, source, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
    [tenantId, normalised, reason, source, notes],
  );
  return changed > 0;
}

export async function isSuppressed(email, tenantId = 1) {
  const row = await queryOne(
    'SELECT 1 FROM suppressions WHERE tenant_id = $1 AND lower(email) = $2',
    [tenantId, normaliseEmail(email)],
  );
  return Boolean(row);
}

/**
 * Bulk membership test for contact import. One query for the whole batch
 * rather than one per address, which matters on a 10,000-row CSV.
 */
export async function suppressedSubset(emails, tenantId = 1) {
  const found = new Set();
  if (emails.length === 0) return found;

  const normalised = [...new Set(emails.map(normaliseEmail))].filter(Boolean);
  if (normalised.length === 0) return found;

  const rows = await query(
    'SELECT lower(email) AS email FROM suppressions WHERE tenant_id = $1 AND lower(email) = ANY($2::text[])',
    [tenantId, normalised],
  );
  for (const row of rows) found.add(row.email);
  return found;
}

export async function listSuppressions({ tenantId = 1, search = '', limit = 100, offset = 0 } = {}) {
  const term = search.trim().toLowerCase();
  const like = `%${term}%`;

  const rows = await query(
    `SELECT * FROM suppressions
      WHERE tenant_id = $1 AND ($2 = '' OR lower(email) LIKE $3)
      ORDER BY created_at DESC
      LIMIT $4 OFFSET $5`,
    [tenantId, term, like, limit, offset],
  );

  const total = (await queryOne(
    `SELECT COUNT(*) AS n FROM suppressions
      WHERE tenant_id = $1 AND ($2 = '' OR lower(email) LIKE $3)`,
    [tenantId, term, like],
  )).n;

  return { rows, total };
}

export async function removeSuppression(id, tenantId = 1) {
  return (await execute(
    'DELETE FROM suppressions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  )) > 0;
}

export async function countSuppressions(tenantId = 1) {
  return (await queryOne('SELECT COUNT(*) AS n FROM suppressions WHERE tenant_id = $1', [tenantId])).n;
}
