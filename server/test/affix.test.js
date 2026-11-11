import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAffix, buildLocal, buildEmail, splitPattern, hasAffix, usablePatterns,
} from '../src/lib/email-patterns.js';
import { patternsFromSeed, predictRows } from '../src/lib/predictor.js';
import { readingsFor } from '../src/lib/name-intelligence.js';

/**
 * Some companies put a constant marker on every address. The real case:
 * ts-syed-baseer@rakuten.com, which is `first-last` wearing a `ts-` prefix
 * and which the matcher rejected outright as unrecognisable.
 *
 * The hard part is not spotting it. It is refusing to act on one sighting,
 * because a single address cannot distinguish "every mailbox here is
 * prefixed" from "this person is a contractor".
 */

const read = (name) => readingsFor(name, null);

// ------------------------------------------------------------ detecting

test('finds an ordinary format behind a prefix', () => {
  const found = detectAffix('ts-syed-baseer@rakuten.com', read('Syed Sharkeel Baseer'));
  assert.equal(found.affix, 'ts-');
  assert.equal(found.base, 'first-last');
  assert.equal(found.pattern, 'ts-|first-last');
});

test('works for the other separators', () => {
  assert.equal(detectAffix('ext.anna.smith@apex.com', read('Anna Smith')).affix, 'ext.');
  assert.equal(detectAffix('c_asmith@apex.com', read('Anna Smith')).affix, 'c_');
});

test('an address with no prefix is not given one', () => {
  assert.equal(detectAffix('anna.smith@apex.com', read('Anna Smith')), null);
});

test('a long run of junk is not a prefix', () => {
  // Without the length and separator bound, anything ending in the
  // surname would "match" and invent a marker out of the rest.
  assert.equal(detectAffix('weirdinternalsystemcodeanna.smith@apex.com', read('Anna Smith')), null);
});

test('a prefix must be closed by a separator', () => {
  // `xanna.smith` is far more likely a different name than a prefix.
  assert.equal(detectAffix('xanna.smith@apex.com', read('Anna Smith')), null);
});

test('an unrelated address still matches nothing', () => {
  assert.equal(detectAffix('emp4417@initech.com', read('Peter Gibbons')), null);
});

// ------------------------------------------------------------- building

test('a prefixed format round-trips', () => {
  const parts = { first: 'Mohammad', last: 'Qureshi' };
  assert.equal(buildLocal('ts-|first-last', parts), 'ts-mohammad-qureshi');
  assert.equal(
    buildEmail('ts-|first-last', parts, 'rakuten.com'),
    'ts-mohammad-qureshi@rakuten.com',
  );
});

test('a prefixed format a name cannot satisfy is still null', () => {
  assert.equal(buildLocal('ts-|fmlast', { first: 'Anna', last: 'Smith' }), null);
});

test('the key splits back into its parts', () => {
  assert.deepEqual(splitPattern('ts-|first-last'), { affix: 'ts-', base: 'first-last' });
  assert.deepEqual(splitPattern('first.last'), { affix: '', base: 'first.last' });
  assert.equal(hasAffix('ts-|first-last'), true);
  assert.equal(hasAffix('first.last'), false);
});

// --------------------------------------------------- one seed is enough

test('a prefixed seed is accepted on its own', () => {
  // It cannot be known from one address whether `ts-` is company-wide or
  // marks this person. That is left to the first send to settle: an
  // unconfirmed company releases one person anyway, so a wrong prefix
  // costs one bounce. Refusing until a second seed arrived just left
  // companies permanently stuck when only one address was ever available.
  const out = patternsFromSeed({
    email: 'ts-syed-baseer@rakuten.com', ownerName: 'Syed Sharkeel Baseer',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.patterns, ['ts-|first-last']);
  assert.equal(out.inferredAffix, 'ts-');
  assert.equal(out.base, 'first-last');
});

const row = (pattern, over = {}) => ({
  pattern, provenance: 'asserted', confirmed_count: 0, rejected_count: 0,
  asserted_count: 1, ...over,
});

test('a prefixed format is usable immediately', () => {
  assert.deepEqual(usablePatterns([row('ts-|first-last')]), ['ts-|first-last']);
});

test('and is still retired by two bounces, like any other', () => {
  assert.deepEqual(
    usablePatterns([row('ts-|first-last', { rejected_count: 2 })]),
    [],
  );
});

// ----------------------------------------------------------- predicting

test('it predicts for everyone else at the company', () => {
  const { results } = predictRows(
    [{ name: 'Mohammad Avez N Qureshi', domain: 'rakuten.com' }],
    new Map([['rakuten.com', { patterns: ['ts-|first-last'], provenance: 'asserted' }]]),
  );
  assert.equal(results[0].email, 'ts-mohammad-qureshi@rakuten.com');
});

const predictOne = (name, patterns, provenance = 'asserted') => predictRows(
  [{ name, domain: 'apex.com' }],
  new Map([['apex.com', { patterns, provenance }]]),
).results[0];

test('a deduced prefix scores lower than a format read directly', () => {
  const plain = predictOne('Anna Smith', ['first.last']);
  const prefixed = predictOne('Anna Smith', ['ts-|first.last']);

  assert.ok(prefixed.score < plain.score, `${prefixed.score} should be under ${plain.score}`);
  // Neither reaches the top band: that is reserved for delivery proof, so
  // an asserted seed sits at medium either way.
  assert.equal(plain.band, 'medium');
  assert.equal(prefixed.band, 'medium');
});

test('deduction plus any other doubt drops it to low', () => {
  // "Sharma, Rajesh" reverses on the comma, which is already a flagged
  // reading. Guessing the prefix on top of that is two guesses deep.
  const shaky = predictOne('Sharma, Rajesh', ['ts-|first.last']);
  assert.equal(shaky.band, 'low');
});

test('a delivery removes the penalty - it is no longer a deduction', () => {
  const proven = predictOne('Anna Smith', ['ts-|first.last'], 'proven');
  assert.equal(proven.band, 'high');
});
