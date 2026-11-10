#!/usr/bin/env node
/**
 * Applies any pending migrations to the configured database.
 *
 *   npm run migrate
 *
 * Safe to run repeatedly: each file is recorded in schema_migrations once it
 * has been applied, and an advisory lock stops two processes racing.
 */
import { env } from '../src/config/env.js';
import { migrate, closePool } from '../src/db/index.js';

const redacted = env.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@');
console.log(`\nDatabase : ${redacted}`);
console.log(`Schema   : ${env.DATABASE_SCHEMA}\n`);

try {
  const applied = await migrate();
  console.log(applied === 0 ? 'Already up to date.\n' : `Done - ${applied} migration(s) applied.\n`);
} catch (error) {
  console.error(`\nMigration failed: ${error.message}\n`);
  if (/ETIMEDOUT|ENOTFOUND|ENETUNREACH/.test(error.message)) {
    console.error('Check DATABASE_URL uses the Supabase connection POOLER host.');
    console.error('The direct db.<ref>.supabase.co host is IPv6-only and times out on IPv4.\n');
  }
  process.exitCode = 1;
} finally {
  await closePool();
}
