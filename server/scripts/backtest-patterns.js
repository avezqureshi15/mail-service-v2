/**
 * Leave-one-out backtest of the email-pattern predictor.
 *
 * READ ONLY - issues SELECTs against `contacts` and writes nothing.
 *
 * For every domain where we hold two or more named contacts, take one real
 * address as the seed, derive the company's format from it, predict a
 * *different* contact at the same domain, and compare the prediction with the
 * address we already know is correct.
 *
 * That yields a true accuracy figure on this list rather than an estimate,
 * and - just as useful - the real distribution of formats, which is what the
 * template set should be pruned or extended against.
 *
 *   node scripts/backtest-patterns.js
 */

import fs from 'node:fs';
import { parse as parseCsv } from 'csv-parse/sync';

import { query, closePool } from '../src/db/index.js';
import { parseEmail } from '../src/lib/email-validation.js';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Flattens a name to the alphabet a local part is built from. Without the
 * accent strip, `García` never matches `garcia` and a perfectly good address
 * is scored as a miss.
 */
function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Consumer mailbox providers have no company format - the local part is
 * whatever the person picked when they signed up.
 *
 * Excluding them is not tidiness, it is correctness. Group three gmail.com
 * addresses together and the learner will happily conclude "gmail.com uses
 * first.last", then predict `john.smith@gmail.com` for every prospect whose
 * address happens to be on Gmail. The production learner needs this same
 * guard.
 */
const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'protonmail.com', 'proton.me',
  'rediffmail.com', 'sify.com', 'inbox.com', 'fastmail.com', 'tutanota.com',
]);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATES = {
  'first.last': (f, l) => `${f}.${l}`,
  'first_last': (f, l) => `${f}_${l}`,
  firstlast: (f, l) => `${f}${l}`,
  'first-last': (f, l) => `${f}-${l}`,
  first: (f) => f,
  last: (f, l) => l,
  flast: (f, l) => `${f[0]}${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  'f_last': (f, l) => `${f[0]}_${l}`,
  firstl: (f, l) => `${f}${l[0]}`,
  'first.l': (f, l) => `${f}.${l[0]}`,
  lastf: (f, l) => `${l}${f[0]}`,
  'last.first': (f, l) => `${l}.${f}`,
  lastfirst: (f, l) => `${l}${f}`,
  'last_first': (f, l) => `${l}_${f}`,
  fl: (f, l) => `${f[0]}${l[0]}`,
  'f.l': (f, l) => `${f[0]}.${l[0]}`,
  firstmlast: (f, l, m) => (m ? `${f}${m[0]}${l}` : null),
  'first.m.last': (f, l, m) => (m ? `${f}.${m[0]}.${l}` : null),
  // Both initials then the surname - `ajkhan` for A J Khan. Added after the
  // first real backtest produced a miss this explains.
  fmlast: (f, l, m) => (m ? `${f[0]}${m[0]}${l}` : null),
  'f.m.last': (f, l, m) => (m ? `${f[0]}.${m[0]}.${l}` : null),
};

const PATTERN_NAMES = Object.keys(TEMPLATES);

function build(pattern, first, last, middle) {
  if (!first || !last) return null;
  try {
    return TEMPLATES[pattern](first, last, middle) || null;
  } catch {
    return null;
  }
}

/**
 * Every template that reproduces this local part. More than one is a real
 * outcome, not a bug - short names and shared initials collide.
 */
function matchPatterns(localPart, first, last, middle) {
  const target = norm(localPart) === localPart ? localPart : localPart.toLowerCase();
  return PATTERN_NAMES.filter((name) => {
    const built = build(name, first, last, middle);
    return built !== null && built === target;
  });
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

/**
 * Reads name/email pairs from a CSV instead of the database, so a real
 * prospect list can be measured without first importing it.
 *
 * Accepts the obvious header spellings: email / email_address, first_name /
 * first / firstname, last_name / last / surname, and a single `name` column
 * that is split on the first space.
 */
function loadCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const records = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true });

  const pick = (row, keys) => {
    for (const key of keys) {
      const found = Object.keys(row).find((k) => k.toLowerCase().replace(/[\s-]/g, '_') === key);
      if (found && row[found]) return row[found];
    }
    return '';
  };

  return records.map((row) => {
    let first = pick(row, ['first_name', 'first', 'firstname', 'given_name']);
    let last = pick(row, ['last_name', 'last', 'lastname', 'surname', 'family_name']);

    if (!first && !last) {
      const whole = pick(row, ['name', 'full_name', 'contact_name']);
      const parts = whole.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        first = parts[0];
        last = parts[parts.length - 1];
      }
    }

    return {
      email: pick(row, ['email', 'email_address', 'mail']),
      first_name: first,
      last_name: last,
      middle_name: pick(row, ['middle_name', 'middle']),
    };
  }).filter((r) => r.email && r.first_name && r.last_name);
}

async function main() {
  const csvArg = process.argv.indexOf('--csv');
  const csvPath = csvArg !== -1 ? process.argv[csvArg + 1] : null;
  // Keeps real addresses out of terminal output and logs. The shape of a miss
  // is the diagnostic value; the actual domain is not.
  const redact = process.argv.includes('--redact');

  let rows;
  let totalContacts;

  if (csvPath) {
    console.log(`Loading ${csvPath}...\n`);
    rows = loadCsv(csvPath);
    totalContacts = rows.length;
  } else {
    console.log('Loading contacts from the database...');
    console.log('(pass --csv <file> to measure a list without importing it)\n');

    rows = await query(`
      SELECT email, first_name, last_name, company
        FROM contacts
       WHERE first_name <> '' AND last_name <> ''
    `);
    totalContacts = (await query('SELECT count(*)::int AS n FROM contacts'))[0].n;
  }

  console.log(`  ${totalContacts} rows total`);
  console.log(`  ${rows.length} with both a first and last name\n`);

  if (rows.length === 0) {
    console.log('Nothing to test against. The backtest needs contacts that carry names.');
    return;
  }

  // Group by domain, skipping role accounts - a shared mailbox follows no
  // personal format, so it can neither teach nor be predicted.
  const byDomain = new Map();
  let roleSkipped = 0;
  let unparseable = 0;
  let freeSkipped = 0;

  for (const row of rows) {
    const parsed = parseEmail(row.email);
    if (!parsed.ok) { unparseable += 1; continue; }
    if (parsed.isRole) { roleSkipped += 1; continue; }
    if (FREE_PROVIDERS.has(parsed.domain)) { freeSkipped += 1; continue; }

    const first = norm(row.first_name);
    const last = norm(row.last_name);
    if (!first || !last) continue;

    if (!byDomain.has(parsed.domain)) byDomain.set(parsed.domain, []);
    byDomain.get(parsed.domain).push({
      email: parsed.email,
      local: parsed.local,
      first,
      last,
      middle: norm(row.middle_name),
      raw: `${row.first_name} ${row.last_name}`,
    });
  }

  console.log(`  ${roleSkipped} role accounts skipped, ${unparseable} unparseable`);
  console.log(`  ${freeSkipped} on consumer providers skipped (gmail, outlook, ...)`);
  console.log(`  ${byDomain.size} distinct company domains\n`);

  const multi = [...byDomain.entries()].filter(([, list]) => list.length >= 2);
  console.log(`  ${multi.length} domains hold 2+ named contacts - these are testable\n`);

  if (multi.length === 0) {
    console.log('No domain has two named contacts, so leave-one-out has nothing to work with.');
    console.log('Single-contact domains can still seed the pattern table; they just cannot');
    console.log('be used to measure accuracy.');
    await reportSingleDomainFormats(byDomain);
    return;
  }

  // --- leave-one-out -------------------------------------------------------

  let attempted = 0;
  let seedUnmatchable = 0;
  let exact = 0;
  let wrong = 0;
  let ambiguousSeed = 0;
  let ambiguousHit = 0;

  const formatCounts = new Map();
  const misses = [];

  for (const [domain, people] of multi) {
    for (let i = 0; i < people.length; i += 1) {
      const target = people[i];
      const seed = people[(i + 1) % people.length];

      const seedPatterns = matchPatterns(seed.local, seed.first, seed.last, seed.middle);

      if (seedPatterns.length === 0) {
        seedUnmatchable += 1;
        continue;
      }

      attempted += 1;
      if (seedPatterns.length > 1) ambiguousSeed += 1;

      for (const p of seedPatterns) {
        formatCounts.set(p, (formatCounts.get(p) ?? 0) + 1);
      }

      // The top pick is the first matching template, which is also the order
      // the production ranker would use.
      const predictedLocal = build(seedPatterns[0], target.first, target.last, target.middle);
      const predicted = predictedLocal ? `${predictedLocal}@${domain}` : null;

      if (predicted === target.email) {
        exact += 1;
        if (seedPatterns.length > 1) ambiguousHit += 1;
      } else {
        wrong += 1;
        if (misses.length < 15) {
          const hide = (addr) => (redact && addr ? `${addr.split('@')[0]}@<domain>` : addr);
          misses.push({
            domain: redact ? '<domain>' : domain,
            seed: hide(seed.email),
            seedPattern: seedPatterns[0],
            name: redact ? `${target.first} ${target.last}`.replace(/\B\w/g, '*') : target.raw,
            predicted: hide(predicted) ?? '(none)',
            actual: hide(target.email),
          });
        }
      }
    }
  }

  // --- report --------------------------------------------------------------

  const pct = (n, d) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

  console.log('='.repeat(64));
  console.log('RESULTS');
  console.log('='.repeat(64));
  console.log();
  console.log(`  Predictions attempted      ${attempted}`);
  console.log(`  Exact match                ${exact}  (${pct(exact, attempted)}%)`);
  console.log(`  Wrong                      ${wrong}  (${pct(wrong, attempted)}%)`);
  console.log();
  console.log(`  Seeds no template matched  ${seedUnmatchable}  - formats outside the template set`);
  console.log(`  Seeds matching 2+ patterns ${ambiguousSeed}, of which ${ambiguousHit} still hit`);
  console.log();

  if (formatCounts.size > 0) {
    console.log('  Formats observed (how often each template explained a real address):');
    const sorted = [...formatCounts.entries()].sort((a, b) => b[1] - a[1]);
    const totalFormat = sorted.reduce((sum, [, n]) => sum + n, 0);
    for (const [name, n] of sorted) {
      const bar = '#'.repeat(Math.max(1, Math.round((n / sorted[0][1]) * 30)));
      console.log(`    ${name.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, totalFormat).padStart(5)}%  ${bar}`);
    }
    console.log();
  }

  if (misses.length > 0) {
    console.log('  Sample misses:');
    for (const m of misses) {
      console.log(`    ${m.name}`);
      console.log(`      seed      ${m.seed}  -> ${m.seedPattern}`);
      console.log(`      predicted ${m.predicted}`);
      console.log(`      actual    ${m.actual}`);
    }
    console.log();
  }

  await reportSingleDomainFormats(byDomain);
}

/**
 * Even domains with a single contact tell us which formats exist in the wild,
 * which is what the template set should be tuned against.
 */
async function reportSingleDomainFormats(byDomain) {
  let matched = 0;
  let unmatched = 0;
  const counts = new Map();

  for (const [, people] of byDomain) {
    for (const person of people) {
      const hits = matchPatterns(person.local, person.first, person.last, person.middle);
      if (hits.length === 0) { unmatched += 1; continue; }
      matched += 1;
      counts.set(hits[0], (counts.get(hits[0]) ?? 0) + 1);
    }
  }

  const total = matched + unmatched;
  if (total === 0) return;

  const pct = (n, d) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

  console.log('='.repeat(64));
  console.log('TEMPLATE COVERAGE  (every named contact, not just testable domains)');
  console.log('='.repeat(64));
  console.log();
  console.log(`  Explained by a template    ${matched} / ${total}  (${pct(matched, total)}%)`);
  console.log(`  Explained by none          ${unmatched} / ${total}  (${pct(unmatched, total)}%)`);
  console.log();
  console.log('  A high "none" figure means the template set is missing formats');
  console.log('  this market actually uses - the cheapest thing to fix.');
  console.log();
}

main()
  .catch((error) => {
    console.error('\nBacktest failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
