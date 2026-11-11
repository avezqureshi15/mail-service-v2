import test from 'node:test';
import assert from 'node:assert/strict';

import {
  predictRows, dedupeByEmail, summariseByDomain, patternsFromSeed,
} from '../src/lib/predictor.js';
import { readingsFor } from '../src/lib/name-intelligence.js';
import { matchPatterns, PATTERNS } from '../src/lib/email-patterns.js';

/**
 * No database: the caller loads every domain's formats in one query and
 * hands them in, which is exactly what keeps a bulk run cheap. Testing the
 * same way keeps these honest about that contract.
 */

const knows = (domain, patterns, provenance = 'proven') =>
  new Map([[domain, { patterns, provenance }]]);

test('applies a known format to a name', () => {
  const { results, skipped } = predictRows(
    [{ name: 'Rajesh Kumar Sharma', domain: 'apex.com' }],
    knows('apex.com', ['first.last']),
  );

  assert.equal(skipped.length, 0);
  assert.equal(results[0].email, 'rajesh.sharma@apex.com');
  assert.equal(results[0].pattern, 'first.last');
  assert.equal(results[0].band, 'high');
  assert.deepEqual(results[0].alternatives, []);
});

test('carries the operator\'s other columns through untouched', () => {
  const { results } = predictRows(
    [{ name: 'Anna Smith', domain: 'apex.com', observation: 'you are hiring', company: 'Apex' }],
    knows('apex.com', ['first.last']),
  );
  assert.equal(results[0].observation, 'you are hiring');
  assert.equal(results[0].company, 'Apex');
});

test('accepts a pasted url as the domain', () => {
  const { results } = predictRows(
    [{ name: 'Anna Smith', domain: 'https://www.apex.com/team' }],
    knows('apex.com', ['first.last']),
  );
  assert.equal(results[0].email, 'anna.smith@apex.com');
});

test('a company we do not know is skipped, and says why', () => {
  const { results, skipped } = predictRows(
    [{ name: 'Anna Smith', domain: 'unknown.com' }],
    knows('apex.com', ['first.last']),
  );
  assert.equal(results.length, 0);
  assert.equal(skipped[0].reason, 'no_format');
});

test('a row with no website is skipped separately', () => {
  const { skipped } = predictRows(
    [{ name: 'Anna Smith', domain: '' }],
    knows('apex.com', ['first.last']),
  );
  assert.equal(skipped[0].reason, 'no_domain');
});

test('an unusable name is skipped with the parser\'s reason', () => {
  const { skipped } = predictRows(
    [{ name: 'Rukaiya', domain: 'apex.com' }, { name: '', domain: 'apex.com' }],
    knows('apex.com', ['first.last']),
  );
  assert.deepEqual(skipped.map((s) => s.reason), ['single_word_name', 'no_name']);
});

test('a nickname becomes a second candidate, and lowers the band', () => {
  const { results } = predictRows(
    [{ name: 'Mike (Michael) Chen', domain: 'apex.com' }],
    knows('apex.com', ['first.last']),
  );
  assert.equal(results[0].email, 'mike.chen@apex.com');
  assert.deepEqual(results[0].alternatives.map((a) => a.email), ['michael.chen@apex.com']);
  // Two plausible answers is not a confident answer.
  assert.equal(results[0].band, 'medium');
});

test('two known formats produce an alternative rather than a silent choice', () => {
  const { results } = predictRows(
    [{ name: 'Anna Smith', domain: 'apex.com' }],
    knows('apex.com', ['first.last', 'flast']),
  );
  assert.equal(results[0].email, 'anna.smith@apex.com');
  assert.deepEqual(results[0].alternatives.map((a) => a.email), ['asmith@apex.com']);
});

test('a format the name cannot satisfy does not become a skip', () => {
  // `fmlast` needs a middle name; the two-word name simply uses the other.
  const { results, skipped } = predictRows(
    [{ name: 'Anna Smith', domain: 'apex.com' }],
    knows('apex.com', ['fmlast', 'first.last']),
  );
  assert.equal(skipped.length, 0);
  assert.equal(results[0].email, 'anna.smith@apex.com');
});

test('a seed we only have the operator\'s word for scores lower', () => {
  const asserted = predictRows(
    [{ name: 'Anna Smith', domain: 'apex.com' }],
    knows('apex.com', ['first.last'], 'asserted'),
  ).results[0];
  const proven = predictRows(
    [{ name: 'Anna Smith', domain: 'apex.com' }],
    knows('apex.com', ['first.last'], 'proven'),
  ).results[0];

  assert.ok(asserted.score < proven.score);
  assert.equal(asserted.band, 'medium');
});

test('a leading-initial owner name teaches first, ahead of last', () => {
  // Mirrors qualifySeed: match the seed against every reading, then rank by
  // PATTERNS. The rules-only split would leave only `last`.
  const matched = new Set();
  for (const reading of readingsFor('D Bhushan', null)) {
    for (const pattern of matchPatterns('bhushan@webknot.in', reading)) matched.add(pattern);
  }
  const patterns = PATTERNS.filter((pattern) => matched.has(pattern));

  assert.equal(patterns[0], 'first');
  assert.ok(patterns.includes('last'));
});

test('a leading-initial reading does not become the top answer', () => {
  // "D Bhushan" with a first-name company: the plain split yields d@, the
  // initial-is-not-given reading yields bhushan@. The real one must win.
  const { results } = predictRows(
    [{ name: 'D Bhushan', domain: 'webknot.in' }],
    knows('webknot.in', ['first']),
  );
  assert.equal(results[0].email, 'bhushan@webknot.in');
  assert.deepEqual(results[0].alternatives.map((a) => a.email), ['d@webknot.in']);
});

test('a leading initial is still used by formats built from the initial', () => {
  // `flast` is meant to take the given initial, so "R. Karthik" must stay
  // rkarthik@ instead of being pushed to the reversed reading (kr@).
  const { results } = predictRows(
    [{ name: 'R. Karthik', domain: 'apex.com' }],
    knows('apex.com', ['flast']),
  );
  assert.equal(results[0].email, 'rkarthik@apex.com');
});

test('a webknot seed taught as first names resolves the whole list', () => {
  const { results } = predictRows(
    [
      { name: 'Avez N Qureshi', domain: 'webknot.in' },
      { name: 'Sandheep Kumar Patro', domain: 'webknot.in' },
      { name: 'Syed Sharkeel Baseer', domain: 'webknot.in' },
      { name: 'Aman Pandey', domain: 'webknot.in' },
    ],
    knows('webknot.in', ['first'], 'asserted'),
  );

  assert.deepEqual(results.map((r) => r.email), [
    'avez@webknot.in',
    'sandheep@webknot.in',
    'syed@webknot.in',
    'aman@webknot.in',
  ]);
  // `first` beats `last` when both were learned from the same seed.
  assert.ok(results.every((r) => r.format === 'first'));
  assert.ok(results.every((r) => r.formatEvidence === 'single-seed'));
});

test('an initial-format candidate is not demoted for using an initial', () => {
  // `fmlast` builds f[0]+m[0]+last, so a one-letter given name is exactly
  // what it is for. It was briefly listed among the full-given-name
  // formats, which pushed rkkarthik@ behind weaker candidates.
  const { results } = predictRows(
    [{ name: 'R K Karthik', domain: 'apex.com' }],
    knows('apex.com', ['fmlast']),
  );
  assert.equal(results[0].email, 'rkkarthik@apex.com');
});

// --------------------------------------------------------------- seeds

test('learns the format from a good seed', () => {
  const result = patternsFromSeed({ email: 'priya.nair@apex.com', ownerName: 'Priya Nair' });
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'apex.com');
  assert.deepEqual(result.patterns, ['first.last']);
});

test('a leading-initial seed teaches first, ahead of last', () => {
  // The real case: bhushan@webknot.in belongs to "D Bhushan". The plain
  // split reads D as the given name and would teach `last`; reading the
  // alternative puts `first` in front, where it belongs.
  const result = patternsFromSeed({ email: 'bhushan@webknot.in', ownerName: 'D Bhushan' });
  assert.equal(result.ok, true);
  assert.equal(result.patterns[0], 'first');
  assert.ok(result.patterns.includes('last'));
});

test('refuses a personal mailbox as a seed', () => {
  const result = patternsFromSeed({ email: 'priya.nair@gmail.com', ownerName: 'Priya Nair' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'free_provider');
});

test('refuses a seed with no usable owner name', () => {
  assert.equal(
    patternsFromSeed({ email: 'priya.nair@apex.com', ownerName: '' }).reason,
    'seed_owner_name_missing',
  );
  assert.equal(
    patternsFromSeed({ email: 'priya.nair@apex.com', ownerName: 'Priya' }).reason,
    'seed_owner_name_missing',
  );
});

test('says so when the seed fits no known format', () => {
  const result = patternsFromSeed({ email: 'emp4417@initech.com', ownerName: 'Peter Gibbons' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_pattern_matched');
});

test('a malformed seed is rejected before anything else', () => {
  assert.equal(patternsFromSeed({ email: 'not-an-address', ownerName: 'A B' }).ok, false);
});

test('the route and the contacts backfill learn the same thing', () => {
  // These were two separate implementations, and they disagreed: the
  // backfill used the plain split, so "D Bhushan" taught `last` there and
  // `first` through the UI, into the same table. One function now, so the
  // only way they can diverge again is by calling something else.
  const viaUi = patternsFromSeed({ email: 'bhushan@webknot.in', ownerName: 'D Bhushan' });
  const viaBackfill = patternsFromSeed({
    email: 'bhushan@webknot.in',
    ownerName: `${'D'} ${'Bhushan'}`.trim(),   // how the script builds it
  });
  assert.deepEqual(viaUi.patterns, viaBackfill.patterns);
});

// ------------------------------------------------------------- dedupe

test('two spellings of one person collapse to the better-scoring row', () => {
  const rows = [
    { email: 'a@apex.com', score: 0.6 },
    { email: 'a@apex.com', score: 0.9 },
    { email: 'b@apex.com', score: 0.5 },
  ];
  const out = dedupeByEmail(rows);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.email === 'a@apex.com').score, 0.9);
});

// ------------------------------------------------------------ rollup

test('companies needing a seed are listed first', () => {
  const results = [
    { domain: 'apex.com', band: 'high' },
    { domain: 'apex.com', band: 'high' },
    { domain: 'apex.com', band: 'medium' },
  ];
  const skipped = [
    { domain: 'globex.io', reason: 'no_format' },
    { domain: 'apex.com', reason: 'single_word_name' },
  ];

  const rollup = summariseByDomain(results, skipped);
  assert.equal(rollup[0].domain, 'globex.io');
  assert.equal(rollup[0].needsSeed, true);

  const apex = rollup.find((r) => r.domain === 'apex.com');
  assert.deepEqual(
    [apex.high, apex.medium, apex.low, apex.skipped, apex.needsSeed],
    [2, 1, 0, 1, false],
  );
});

test('rows with no website at all are grouped under a readable label', () => {
  const rollup = summariseByDomain([], [{ domain: '', reason: 'no_domain' }]);
  assert.equal(rollup[0].domain, '(no website)');
});
