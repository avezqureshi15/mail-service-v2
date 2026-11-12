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
// Tests in a file run sequentially; one connection is enough. Combined with
// the runner's concurrency cap this avoids exhausting the shared Supabase pool.
process.env.DATABASE_POOL_MAX = '1';

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

/**
 * A sending mailbox for tests that queue or send.
 *
 * Every send job carries a mailbox_id, and the sequencer skips an enrollment
 * whose campaign has none - so any test that exercises the queue needs one of
 * these. The password is sealed with the real secret-box so the column is
 * populated the same way production rows are.
 */
export async function makeTestMailbox(overrides = {}) {
  const { queryOne } = await import('../../src/db/index.js');
  const { seal } = await import('../../src/lib/secret-box.js');
  const { loadMailboxes } = await import('../../src/db/repositories/mailboxes.js');

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fromEmail = overrides.fromEmail ?? `sender-${suffix}@test.invalid`;
  const imapEnabled = overrides.imapEnabled ?? false;

  // The table refuses imap_enabled without somewhere to connect, so a
  // fixture that asks for IMAP has to carry credentials too.
  const row = await queryOne(
    `INSERT INTO mailboxes (
       label, provider, from_name, from_email, sending_domain, dkim_selector,
       smtp_host, smtp_port, smtp_user, smtp_password_cipher,
       imap_enabled, imap_host, imap_user, imap_password_cipher,
       is_active, is_default
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE, $15)
     RETURNING *`,
    [
      overrides.label ?? `test-mailbox-${suffix}`,
      overrides.provider ?? 'other',
      overrides.fromName ?? 'Test Sender',
      fromEmail,
      overrides.sendingDomain ?? 'test.invalid',
      overrides.dkimSelector ?? 'default',
      overrides.smtpHost ?? 'smtp.test.invalid',
      overrides.smtpPort ?? 465,
      overrides.smtpUser ?? fromEmail,
      seal('test-password'),
      imapEnabled,
      imapEnabled ? (overrides.imapHost ?? 'imap.test.invalid') : '',
      imapEnabled ? (overrides.imapUser ?? fromEmail) : '',
      imapEnabled ? seal('test-imap-password') : null,
      overrides.isDefault ?? false,
    ],
  );

  // The synchronous getters read a cache, so it has to be refreshed before
  // anything under test looks the new mailbox up.
  await loadMailboxes();
  return row;
}
