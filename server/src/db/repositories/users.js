import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../index.js';

const BCRYPT_ROUNDS = 12;

const PUBLIC_COLUMNS = 'id, tenant_id, email, name, role, is_active, created_at, last_login_at';

export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function findByEmail(email, tenantId = 1) {
  return queryOne(
    'SELECT * FROM users WHERE tenant_id = $1 AND lower(email) = $2',
    [tenantId, String(email).trim().toLowerCase()],
  );
}

export function findById(id) {
  return queryOne(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
}

export function listUsers(tenantId = 1) {
  return query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
}

export async function createUser({ email, name, password, role = 'sender', tenantId = 1 }) {
  const passwordHash = await hashPassword(password);
  return queryOne(
    `INSERT INTO users (tenant_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [tenantId, String(email).trim().toLowerCase(), name ?? '', passwordHash, role],
  );
}

export function setActive(id, isActive) {
  return queryOne(
    `UPDATE users SET is_active = $1 WHERE id = $2 RETURNING ${PUBLIC_COLUMNS}`,
    [Boolean(isActive), id],
  );
}

export async function setPassword(id, password) {
  const passwordHash = await hashPassword(password);
  return queryOne(
    `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING ${PUBLIC_COLUMNS}`,
    [passwordHash, id],
  );
}

export function recordLogin(id) {
  return execute('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function countUsers(tenantId = 1) {
  return (await queryOne('SELECT COUNT(*) AS n FROM users WHERE tenant_id = $1', [tenantId])).n;
}

export function logAction({ userId, action, entity = '', entityId = null, detail = {} }) {
  return execute(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)',
    [userId ?? null, action, entity, entityId, JSON.stringify(detail)],
  );
}

export function recentAudit(limit = 50) {
  return query(
    `SELECT a.*, u.email AS user_email, u.name AS user_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC
      LIMIT $1`,
    [limit],
  );
}
