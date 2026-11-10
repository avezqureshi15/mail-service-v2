import { query, queryOne, execute, transaction } from '../index.js';
import { normaliseEmail } from './suppressions.js';

export function upsertContact({
  email,
  firstName = '',
  lastName = '',
  company = '',
  customFields = {},
  isRoleAccount = false,
  source = 'import',
  tenantId = 1,
}) {
  // An existing contact keeps any name or company it already has when the
  // incoming row leaves those blank - a later import with fewer columns
  // should not wipe detail gathered earlier.
  return queryOne(
    `INSERT INTO contacts (tenant_id, email, first_name, last_name, company, custom_fields, is_role_account, source)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET
       first_name    = CASE WHEN excluded.first_name <> '' THEN excluded.first_name ELSE contacts.first_name END,
       last_name     = CASE WHEN excluded.last_name  <> '' THEN excluded.last_name  ELSE contacts.last_name  END,
       company       = CASE WHEN excluded.company    <> '' THEN excluded.company    ELSE contacts.company    END,
       custom_fields = excluded.custom_fields,
       updated_at    = now()
     RETURNING *`,
    [
      tenantId,
      normaliseEmail(email),
      firstName,
      lastName,
      company,
      JSON.stringify(customFields ?? {}),
      Boolean(isRoleAccount),
      source,
    ],
  );
}

/**
 * The same upsert for many rows at a time.
 *
 * A CSV import used to run one statement per contact, which was fine against
 * a local file and is not against a network database - fifty thousand rows
 * would be fifty thousand round trips. Sent in chunks through `unnest`
 * instead, so a large import is tens of statements rather than tens of
 * thousands.
 *
 * Duplicates within a chunk are collapsed first: Postgres refuses to let one
 * statement update the same row twice, so two rows for the same address
 * would abort the whole import. The last occurrence wins, matching what the
 * row-at-a-time version did.
 *
 * @returns {Promise<number[]>} contact ids, in input order of first appearance
 */
export async function upsertManyContacts(entries, tenantId = 1) {
  if (entries.length === 0) return [];

  const byEmail = new Map();
  for (const entry of entries) {
    byEmail.set(normaliseEmail(entry.email), { ...entry, email: normaliseEmail(entry.email) });
  }
  const unique = [...byEmail.values()];

  const CHUNK = 1000;
  const ids = [];

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = await query(
      `INSERT INTO contacts (tenant_id, email, first_name, last_name, company, custom_fields, is_role_account, source)
       SELECT $1, e.email, e.first_name, e.last_name, e.company, e.custom_fields::jsonb, e.is_role_account, e.source
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::text[])
              AS e(email, first_name, last_name, company, custom_fields, is_role_account, source)
       ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET
         first_name    = CASE WHEN excluded.first_name <> '' THEN excluded.first_name ELSE contacts.first_name END,
         last_name     = CASE WHEN excluded.last_name  <> '' THEN excluded.last_name  ELSE contacts.last_name  END,
         company       = CASE WHEN excluded.company    <> '' THEN excluded.company    ELSE contacts.company    END,
         custom_fields = excluded.custom_fields,
         updated_at    = now()
       RETURNING id`,
      [
        tenantId,
        chunk.map((c) => c.email),
        chunk.map((c) => c.firstName ?? ''),
        chunk.map((c) => c.lastName ?? ''),
        chunk.map((c) => c.company ?? ''),
        chunk.map((c) => JSON.stringify(c.customFields ?? {})),
        chunk.map((c) => Boolean(c.isRoleAccount)),
        chunk.map((c) => c.source ?? 'import'),
      ],
    );
    for (const row of rows) ids.push(row.id);
  }

  return ids;
}

export function findById(id, tenantId = 1) {
  return queryOne('SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
}

export function findByEmail(email, tenantId = 1) {
  return queryOne(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND lower(email) = $2',
    [tenantId, normaliseEmail(email)],
  );
}

export function setStatus(id, status) {
  return execute('UPDATE contacts SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
}

export function setStatusByEmail(email, status, tenantId = 1) {
  return execute(
    'UPDATE contacts SET status = $1, updated_at = now() WHERE tenant_id = $2 AND lower(email) = $3',
    [status, tenantId, normaliseEmail(email)],
  );
}

export async function listContacts({
  tenantId = 1, search = '', listId = null, status = null, limit = 50, offset = 0,
} = {}) {
  const term = search.trim().toLowerCase();
  const like = `%${term}%`;
  const params = [tenantId, term, like, listId, status];

  const where = `
    c.tenant_id = $1
    AND ($2 = '' OR lower(c.email) LIKE $3 OR lower(c.first_name) LIKE $3
         OR lower(c.last_name) LIKE $3 OR lower(c.company) LIKE $3)
    AND ($4::int IS NULL OR EXISTS (
          SELECT 1 FROM list_contacts lc WHERE lc.contact_id = c.id AND lc.list_id = $4::int))
    AND ($5::text IS NULL OR c.status = $5::text)
  `;

  const rows = await query(
    `SELECT c.* FROM contacts c WHERE ${where} ORDER BY c.created_at DESC LIMIT $6 OFFSET $7`,
    [...params, limit, offset],
  );

  const total = (await queryOne(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where}`, params)).n;

  return { rows, total };
}

export async function countByStatus(tenantId = 1) {
  const rows = await query(
    'SELECT status, COUNT(*) AS n FROM contacts WHERE tenant_id = $1 GROUP BY status',
    [tenantId],
  );
  const counts = { active: 0, unsubscribed: 0, bounced: 0, complained: 0 };
  for (const row of rows) counts[row.status] = row.n;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

export async function deleteContact(id, tenantId = 1) {
  return (await execute('DELETE FROM contacts WHERE id = $1 AND tenant_id = $2', [id, tenantId])) > 0;
}

// --- Lists -----------------------------------------------------------------

export function createList({ name, description = '', createdBy = null, tenantId = 1 }) {
  return queryOne(
    'INSERT INTO lists (tenant_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
    [tenantId, name, description, createdBy],
  );
}

export function getList(id, tenantId = 1) {
  return queryOne('SELECT * FROM lists WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
}

export function findListByName(name, tenantId = 1) {
  return queryOne(
    'SELECT * FROM lists WHERE tenant_id = $1 AND lower(name) = lower($2)',
    [tenantId, name],
  );
}

export function listLists(tenantId = 1) {
  return query(
    `SELECT l.*, (SELECT COUNT(*) FROM list_contacts lc WHERE lc.list_id = l.id) AS contact_count
       FROM lists l
      WHERE l.tenant_id = $1
      ORDER BY l.created_at DESC`,
    [tenantId],
  );
}

export async function addToList(listId, contactId) {
  return (await execute(
    'INSERT INTO list_contacts (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [listId, contactId],
  )) > 0;
}

/**
 * Adds many contacts in one statement rather than one round trip each - on a
 * several-thousand-row import the difference is minutes.
 */
export async function addManyToList(listId, contactIds) {
  if (contactIds.length === 0) return 0;
  return execute(
    `INSERT INTO list_contacts (list_id, contact_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [listId, contactIds],
  );
}

export async function removeFromList(listId, contactId) {
  return (await execute(
    'DELETE FROM list_contacts WHERE list_id = $1 AND contact_id = $2',
    [listId, contactId],
  )) > 0;
}

export async function deleteList(id, tenantId = 1) {
  return (await execute('DELETE FROM lists WHERE id = $1 AND tenant_id = $2', [id, tenantId])) > 0;
}

/**
 * Mailable members of a list: active status and not on the suppression list.
 * The sender re-checks suppression at claim time too - this is the cheap
 * up-front filter, not the guarantee.
 */
export function mailableListMembers(listId, tenantId = 1) {
  return query(
    `SELECT c.*
       FROM contacts c
       JOIN list_contacts lc ON lc.contact_id = c.id
      WHERE lc.list_id = $1
        AND c.tenant_id = $2
        AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM suppressions s
           WHERE s.tenant_id = c.tenant_id AND lower(s.email) = lower(c.email)
        )`,
    [listId, tenantId],
  );
}

export { transaction };
