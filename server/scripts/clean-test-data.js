#!/usr/bin/env node
/**
 * Removes data left behind by earlier test runs, when the suite still wrote
 * into the development database.
 *
 *   node scripts/clean-test-data.js --dry-run
 *   node scripts/clean-test-data.js
 *
 * Test fixtures are identifiable by their `@seq.test` and `@example.com`
 * addresses. Real contacts are untouched, and the script lists exactly what
 * it will remove before removing it.
 *
 * The suite no longer shares a schema with the application - each run creates
 * its own and drops it afterwards - so nothing new accumulates here. This
 * stays for fixtures written before that was true, and for a walkthrough done
 * by hand against the real schema.
 */
import { parseArgs } from 'node:util';
import { query, queryOne, transaction, closePool } from '../src/db/index.js';
import { env } from '../src/config/env.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dryRun = values['dry-run'];

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Domains the test suite and the API walkthrough used. Anything else is real.
const TEST_DOMAINS = ['@seq.test', '@example.com'];
// Fixtures on real domains, so they cannot be matched by pattern without
// risking genuine contacts. Listed in full rather than guessed at.
const TEST_ADDRESSES = ['dana@cloudflare.com', 'sam@github.com', 'info@cloudflare.com'];

// $1 = the test domain suffixes, $2 = the named addresses.
const TEST_MATCH = `(
  EXISTS (SELECT 1 FROM unnest($1::text[]) AS d(suffix) WHERE email LIKE '%' || d.suffix)
  OR email = ANY($2::text[])
)`;
const matchParams = [TEST_DOMAINS, TEST_ADDRESSES];

/** Host only - the connection string carries the password. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured database';
  }
}

async function main() {
  console.log(`\n${bold('Test data in')} ${dim(`${hostOf(env.DATABASE_URL)} schema=${env.DATABASE_SCHEMA}`)}\n`);

  const [contacts, campaigns, suppressions, lists, users] = await Promise.all([
    query(`SELECT id, email FROM contacts WHERE ${TEST_MATCH}`, matchParams),
    // Campaigns the sequencer tests created are named after their fixture contact.
    query("SELECT id, name FROM campaigns WHERE name LIKE 'seq-%@seq.test' OR name = 'Q4 Outreach'"),
    query(`SELECT id, email FROM suppressions WHERE ${TEST_MATCH}`, matchParams),
    query("SELECT id, name FROM lists WHERE name = 'Q4 Prospects'"),
    // Accounts created during the walkthrough. A real admin is never matched.
    query("SELECT id, email FROM users WHERE email IN ('admin@example.com', 'rep@example.com')"),
  ]);

  const groups = [
    ['contacts', contacts, (r) => r.email],
    ['campaigns', campaigns, (r) => r.name],
    ['suppressions', suppressions, (r) => r.email],
    ['lists', lists, (r) => r.name],
    ['users', users, (r) => r.email],
  ];

  let total = 0;
  for (const [label, rows, describe] of groups) {
    total += rows.length;
    console.log(`  ${String(rows.length).padStart(4)} ${label}`);
    for (const row of rows.slice(0, 3)) console.log(dim(`       ${describe(row)}`));
    if (rows.length > 3) console.log(dim(`       ... and ${rows.length - 3} more`));
  }

  if (total === 0) {
    console.log(green('\n  Nothing to clean.\n'));
    return;
  }

  if (dryRun) {
    console.log(dim('\n  Dry run - nothing was deleted. Re-run without --dry-run to remove.\n'));
    return;
  }

  const realUsers = (await queryOne(
    "SELECT COUNT(*) AS n FROM users WHERE email NOT IN ('admin@example.com', 'rep@example.com')",
  )).n;

  if (users.length > 0 && realUsers === 0) {
    console.log('\n  Skipping the test users - they are the only accounts that exist,');
    console.log('  and deleting them would lock you out. Create your own admin first:');
    console.log(dim('    npm run seed:admin\n'));
  }

  // Foreign keys cascade from campaigns and contacts to jobs, enrollments,
  // steps and tracking events, so those do not need deleting explicitly.
  // One statement per table rather than one per row: the ids go in as arrays.
  await transaction(async (tx) => {
    await tx.execute('DELETE FROM campaigns WHERE id = ANY($1::int[])', [campaigns.map((r) => r.id)]);
    await tx.execute('DELETE FROM contacts WHERE id = ANY($1::int[])', [contacts.map((r) => r.id)]);
    await tx.execute('DELETE FROM suppressions WHERE id = ANY($1::int[])', [suppressions.map((r) => r.id)]);
    await tx.execute('DELETE FROM lists WHERE id = ANY($1::int[])', [lists.map((r) => r.id)]);
    if (realUsers > 0) {
      await tx.execute('DELETE FROM users WHERE id = ANY($1::int[])', [users.map((r) => r.id)]);
    }
  });

  console.log(green(`\n  Removed ${total} record(s).\n`));
}

try {
  await main();
} finally {
  // Without this the pool keeps the event loop alive and the script hangs.
  await closePool();
}
