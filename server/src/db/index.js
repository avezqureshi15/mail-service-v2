import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';

const { Pool, types } = pg;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Return NUMERIC as a JavaScript number. Everything stored as NUMERIC here is
// a rate or a small count, well inside the safe integer range; the driver's
// default of returning strings would quietly break arithmetic in the stats.
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));
// COUNT() comes back as BIGINT (int8), also a string by default.
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : Number(value)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Supabase terminates TLS with a certificate this client has no CA bundle
  // for; the connection is still encrypted. Set DATABASE_CA to the project's
  // certificate to verify it properly.
  ssl: env.DATABASE_CA
    ? { ca: env.DATABASE_CA, rejectUnauthorized: true }
    : { rejectUnauthorized: false },
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  // Everything lives in one schema so the test suite can be pointed at its
  // own and physically cannot touch production tables.
  options: `-c search_path=${env.DATABASE_SCHEMA},public`,
});

// A pool error with no listener is an uncaught exception that kills the
// process - and a dropped backend connection is routine, not fatal.
pool.on('error', (error) => {
  console.error('[db] idle client error:', error.message);
});

/** Runs a query and returns the rows. */
export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

/** Runs a query expected to match at most one row. */
export async function queryOne(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] ?? null;
}

/** Runs a statement and returns how many rows it affected. */
export async function execute(text, params = []) {
  const result = await pool.query(text, params);
  return result.rowCount ?? 0;
}

/**
 * Runs `fn` inside a transaction on a single dedicated connection.
 *
 * The callback receives a client whose `query` is bound to that connection -
 * using the pool directly inside a transaction would take a different
 * connection and silently escape it, which is the classic way to lose
 * atomicity without any error appearing.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: async (text, params = []) => (await client.query(text, params)).rows,
      queryOne: async (text, params = []) => (await client.query(text, params)).rows[0] ?? null,
      execute: async (text, params = []) => (await client.query(text, params)).rowCount ?? 0,
      raw: client,
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applies any migration files that have not run yet.
 *
 * Each file runs inside its own transaction, so a failure part-way leaves the
 * schema untouched rather than half-applied. An advisory lock keeps two
 * processes starting at once - which `node --watch` does routinely - from
 * both trying to create the same tables.
 */
export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  let applied = 0;

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${env.DATABASE_SCHEMA}`);
    await client.query(`SET search_path TO ${env.DATABASE_SCHEMA}, public`);

    // Arbitrary but fixed key; any concurrent starter waits here.
    await client.query('SELECT pg_advisory_lock(4927301)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );

    const files = fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }

      log(`  applied ${file}`);
      applied += 1;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(4927301)').catch(() => {});
    client.release();
  }

  return applied;
}

export async function closePool() {
  await pool.end();
}
