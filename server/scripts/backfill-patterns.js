/**
 * Learns company address formats from the contacts already in the database.
 *
 * Every contact is a seed nobody had to supply: an address, a first name
 * and a last name is exactly what the reverse matcher needs. Running this
 * once means the predictor is never cold - it wakes up already knowing
 * every company the list has ever touched.
 *
 * Dry by default, because it writes to a live table:
 *
 *   node scripts/backfill-patterns.js            # report only
 *   node scripts/backfill-patterns.js --write    # actually record
 */

import { query, closePool } from '../src/db/index.js';
import { recordPatterns } from '../src/db/repositories/predictions.js';
import { parseEmail } from '../src/lib/email-validation.js';
import { isFreeProvider } from '../src/lib/email-patterns.js';
import { patternsFromSeed } from '../src/lib/predictor.js';

const WRITE = process.argv.includes('--write');
const TENANT = 1;

async function main() {
  console.log(WRITE ? 'Backfilling patterns from contacts...\n' : 'Dry run - nothing will be written.\n');

  // A bounced contact's address did not work, so it is not evidence of
  // anything. Everything else is fair game.
  const rows = await query(
    `SELECT c.email, c.first_name, c.last_name,
            EXISTS (SELECT 1 FROM send_jobs j
                     WHERE j.contact_id = c.id AND j.status = 'sent')  AS delivered,
            EXISTS (SELECT 1 FROM replies r WHERE r.contact_id = c.id) AS replied
       FROM contacts c
      WHERE c.tenant_id = $1
        AND c.first_name <> '' AND c.last_name <> ''
        AND c.status <> 'bounced'`,
    [TENANT],
  );

  console.log(`  ${rows.length} contacts carry both a first and last name\n`);
  if (rows.length === 0) {
    console.log('Nothing to learn from yet. Import or predict some contacts first.');
    return;
  }

  const learned = [];
  const byDomain = new Map();
  const counts = { role: 0, free: 0, disposable: 0, malformed: 0, noMatch: 0, matched: 0 };

  for (const row of rows) {
    const parsed = parseEmail(row.email);
    if (!parsed.ok) { counts.malformed += 1; continue; }
    if (parsed.isRole) { counts.role += 1; continue; }
    if (parsed.isDisposable) { counts.disposable += 1; continue; }
    if (isFreeProvider(parsed.domain)) { counts.free += 1; continue; }

    // The same learner the predictor route uses, so a contact stored as
    // "D Bhushan" with bhushan@ teaches `first` here exactly as it would
    // through the UI. No model readings: this runs over thousands of rows
    // offline, and the rules' alternatives already cover the leading
    // initial, which is the case that mattered.
    const result = patternsFromSeed({
      email: parsed.email,
      ownerName: `${row.first_name} ${row.last_name}`.trim(),
    });
    if (!result.ok) { counts.noMatch += 1; continue; }

    counts.matched += 1;
    // Our own delivery outranks an address we merely hold a record of.
    const provenance = (row.delivered || row.replied) ? 'proven' : 'asserted';

    for (const pattern of result.patterns) {
      learned.push({ domain: result.domain, pattern, provenance, learnedFrom: parsed.email });
      if (!byDomain.has(result.domain)) byDomain.set(result.domain, new Set());
      byDomain.get(result.domain).add(pattern);
    }
  }

  console.log('  skipped:');
  console.log(`    role accounts (info@, sales@)      ${counts.role}`);
  console.log(`    consumer providers (gmail, ...)    ${counts.free}`);
  console.log(`    disposable domains                 ${counts.disposable}`);
  console.log(`    malformed addresses                ${counts.malformed}`);
  console.log(`    matched no known format            ${counts.noMatch}`);
  console.log();
  console.log(`  learned a format for ${byDomain.size} companies from ${counts.matched} addresses\n`);

  if (byDomain.size > 0) {
    const spread = new Map();
    for (const patterns of byDomain.values()) {
      for (const pattern of patterns) spread.set(pattern, (spread.get(pattern) ?? 0) + 1);
    }
    const sorted = [...spread.entries()].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((sum, [, n]) => sum + n, 0);

    console.log('  formats found:');
    for (const [pattern, n] of sorted) {
      const bar = '#'.repeat(Math.max(1, Math.round((n / sorted[0][1]) * 28)));
      console.log(`    ${pattern.padEnd(14)} ${String(n).padStart(5)}  ${((n / total) * 100).toFixed(1).padStart(5)}%  ${bar}`);
    }
    console.log();

    // More than one format for a domain is not an error - a short name can
    // be explained two ways, and an acquired company really does run two.
    const contested = [...byDomain.entries()].filter(([, p]) => p.size > 1);
    if (contested.length > 0) {
      console.log(`  ${contested.length} companies matched more than one format.`);
      console.log('  Both are kept; delivery will settle which is right.\n');
    }
  }

  if (!WRITE) {
    console.log('Re-run with --write to record these.');
    return;
  }

  const written = await recordPatterns(learned, TENANT);
  console.log(`Recorded ${written} pattern rows across ${byDomain.size} companies.`);
}

main()
  .catch((error) => {
    console.error('\nBackfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
