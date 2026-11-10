/**
 * Points the app at a scratch Postgres schema.
 *
 * Import this FIRST in any test that touches the database. ES modules are
 * evaluated in import order, so this runs before `config/env.js` reads
 * `process.env` and freezes the configuration - which is the only window in
 * which the override can take effect.
 *
 * The suite shares one Supabase project with the running service, so
 * isolation is by schema rather than by database: every run gets a schema of
 * its own, migrates into it, and drops it at the end. Tables created here
 * cannot be seen from `public`, so a test that truncates contacts cannot
 * reach the real ones.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED = new Set(['public', 'pg_catalog', 'information_schema']);

// `node --test` runs each file in its own process, and nothing has read
// .env yet at this point - config/env.js is what normally does it, and this
// module deliberately runs before that. Load it here so DATABASE_URL is
// available, the same way the application does.
//
// Variables already set in the real environment win over the file, so the
// schema override below survives env.js loading the same file again.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(serverRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Unique per run, so two suites in parallel - or a run that crashed before
// cleaning up - cannot collide.
const schema = `test_${process.pid}_${Date.now().toString(36)}`;

process.env.DATABASE_SCHEMA = schema;
// One connection is plenty for a test run, and it keeps the shared pooler
// from filling up with idle connections from repeated runs.
process.env.DATABASE_POOL_MAX = '2';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must be set to run the tests. They create a scratch schema '
    + 'in that database and drop it afterwards.',
  );
}

export const testSchema = schema;

/**
 * Creates the scratch schema and applies the migrations into it.
 *
 * Imported lazily so this module can set the environment before anything
 * reads it.
 */
export async function setupTestSchema() {
  if (RESERVED.has(schema)) {
    throw new Error(`Refusing to run the test suite against the ${schema} schema.`);
  }

  const { pool, migrate } = await import('../../src/db/index.js');

  // Created outside the pool's search_path, which does not exist yet.
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    client.release();
  }

  await migrate({ log: () => {} });
}

/** Drops the scratch schema and closes the pool. */
export async function teardownTestSchema() {
  const { pool, closePool } = await import('../../src/db/index.js');

  // Guarded again rather than trusting the value set above: this statement
  // would destroy the application's tables if the schema name were ever
  // wrong, and a test helper is not worth that risk.
  if (RESERVED.has(schema) || !schema.startsWith('test_')) {
    throw new Error(`Refusing to drop schema "${schema}".`);
  }

  try {
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      client.release();
    }
  } finally {
    await closePool();
  }
}
