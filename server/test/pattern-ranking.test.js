import test from 'node:test';
import assert from 'node:assert/strict';

// From the pure module, not the repository: importing the repository would
// open a connection pool to rank some plain objects, and with every test
// file doing that the suite exhausts the connection pooler.
import { usablePatterns } from '../src/lib/email-patterns.js';

/**
 * `usablePatterns` decides which format a company's next prediction leads
 * with, so its ordering is the feedback loop. It had no test at all, and a
 * change that sorted purely on the static prior - throwing away provenance
 * and counts - passed a full green suite while silently switching the
 * learning off.
 *
 * The rows below are shaped exactly as `patternsForDomains` returns them.
 */

const row = (pattern, over = {}) => ({
  pattern,
  provenance: 'asserted',
  confirmed_count: 0,
  rejected_count: 0,
  ...over,
});

test('a format proven by delivery beats one a seed merely asserted', () => {
  const rows = [
    row('flast', { provenance: 'proven', confirmed_count: 10 }),
    row('first.last'),
  ];
  // `first.last` outranks `flast` in the global prior, and must still lose.
  assert.deepEqual(usablePatterns(rows), ['flast', 'first.last']);
});

test('more successful deliveries win, whatever the prior says', () => {
  const rows = [
    row('first.last', { confirmed_count: 1 }),
    row('flast', { confirmed_count: 6 }),
  ];
  assert.deepEqual(usablePatterns(rows), ['flast', 'first.last']);
});

test('a bounce pushes a format down even before it is retired', () => {
  const rows = [
    row('first.last', { rejected_count: 1 }),
    row('flast', { confirmed_count: 4 }),
  ];
  assert.equal(usablePatterns(rows)[0], 'flast');
});

test('the global prior settles a genuine tie, and only then', () => {
  // Both asserted by a seed, neither tried. This is the case the prior is
  // for: `first` really is more common than `last`.
  assert.deepEqual(usablePatterns([row('last'), row('first')]), ['first', 'last']);
  assert.deepEqual(
    usablePatterns([row('last', { confirmed_count: 2 }), row('first', { confirmed_count: 2 })]),
    ['first', 'last'],
  );
});

test('input order does not decide the answer', () => {
  const proven = row('flast', { provenance: 'proven', confirmed_count: 3 });
  const asserted = row('first.last');
  assert.deepEqual(usablePatterns([proven, asserted]), ['flast', 'first.last']);
  assert.deepEqual(usablePatterns([asserted, proven]), ['flast', 'first.last']);
});

test('a format disproved twice with nothing to its credit is dropped', () => {
  const rows = [row('first.last', { rejected_count: 2 }), row('flast')];
  assert.deepEqual(usablePatterns(rows), ['flast']);
});

test('a format that has also succeeded survives two bounces', () => {
  // People leave companies; two departures must not retire a format that
  // has otherwise been delivering.
  const rows = [row('first.last', { rejected_count: 2, confirmed_count: 5 })];
  assert.deepEqual(usablePatterns(rows), ['first.last']);
});

test('an unrecognised pattern sorts last rather than throwing', () => {
  const rows = [row('something-we-retired'), row('first.last')];
  assert.deepEqual(usablePatterns(rows), ['first.last', 'something-we-retired']);
});

test('no rows means no formats', () => {
  assert.deepEqual(usablePatterns([]), []);
});
