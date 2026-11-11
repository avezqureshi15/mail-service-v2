import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseName, normaliseDomain, isFreeProvider, buildLocal, buildEmail,
  matchPatterns, predict, scoreConfidence,
} from '../src/lib/email-patterns.js';

/**
 * No database and no network: this is pure string work, so it runs in
 * milliseconds and cannot be broken by a schema change.
 *
 * Several cases below are taken from a backtest over a real prospect list
 * rather than invented - they are the ones that actually went wrong.
 */

// --------------------------------------------------------------- names

test('strips accents so a real address still matches', () => {
  assert.equal(normaliseName('García'), 'garcia');
  assert.equal(normaliseName('María José'), 'mariajose');
});

test('drops apostrophes, hyphens and particles', () => {
  assert.equal(normaliseName("O'Brien"), 'obrien');
  assert.equal(normaliseName('Garcia-Lopez'), 'garcialopez');
  assert.equal(normaliseName('van der Berg'), 'vanderberg');
});

test('empty and junk names flatten to nothing rather than throwing', () => {
  assert.equal(normaliseName(null), '');
  assert.equal(normaliseName('   '), '');
  assert.equal(normaliseName('...'), '');
});

// ------------------------------------------------------------- domains

test('accepts whatever shape of domain was pasted', () => {
  for (const input of [
    'apex.com', 'APEX.com ', 'www.apex.com', 'https://apex.com',
    'http://www.apex.com/about-us', 'https://apex.com/x?y=1#z', 'apex.com:443',
    'apex.com.',
  ]) {
    assert.equal(normaliseDomain(input), 'apex.com', `failed on ${input}`);
  }
});

test('pulls the domain out of an address pasted by mistake', () => {
  assert.equal(normaliseDomain('priya.nair@apex.com'), 'apex.com');
});

test('keeps a real subdomain but drops www', () => {
  assert.equal(normaliseDomain('mail.apex.com'), 'mail.apex.com');
  assert.equal(normaliseDomain('www.apex.com'), 'apex.com');
});

test('rejects anything that is not a domain', () => {
  assert.equal(normaliseDomain('Apex Solutions'), '');
  assert.equal(normaliseDomain('localhost'), '');
  assert.equal(normaliseDomain(''), '');
});

test('consumer providers are recognised through a url', () => {
  assert.equal(isFreeProvider('gmail.com'), true);
  assert.equal(isFreeProvider('https://www.rediffmail.com'), true);
  assert.equal(isFreeProvider('apex.com'), false);
});

// ------------------------------------------------------------ building

const priya = { first: 'Priya', last: 'Nair' };

test('builds each format from the same name', () => {
  assert.equal(buildLocal('first.last', priya), 'priya.nair');
  assert.equal(buildLocal('flast', priya), 'pnair');
  assert.equal(buildLocal('first', priya), 'priya');
  assert.equal(buildLocal('firstlast', priya), 'priyanair');
  assert.equal(buildLocal('lastf', priya), 'nairp');
  assert.equal(buildLocal('f.l', priya), 'p.n');
});

test('formats needing a middle name opt out when there is none', () => {
  assert.equal(buildLocal('fmlast', priya), null);
  assert.equal(buildLocal('fmlast', { ...priya, middle: 'Kumar' }), 'pknair');
  assert.equal(buildLocal('first.m.last', { ...priya, middle: 'K' }), 'priya.k.nair');
});

test('a name missing either half builds nothing', () => {
  assert.equal(buildLocal('first.last', { first: 'Priya', last: '' }), null);
  assert.equal(buildLocal('first', { first: '', last: 'Nair' }), null);
});

test('buildEmail needs a usable domain', () => {
  assert.equal(buildEmail('first.last', priya, 'apex.com'), 'priya.nair@apex.com');
  assert.equal(buildEmail('first.last', priya, 'Apex Solutions'), null);
});

// ------------------------------------------------------------ matching

test('one format explains the address', () => {
  assert.deepEqual(matchPatterns('priya.nair@apex.com', priya), ['first.last']);
});

test('reports every format that fits rather than picking one', () => {
  // Shared initial: `fl` and `f.l` differ, but first/last both start with j,
  // so lastf and flast collide on a name like this.
  const matches = matchPatterns('jj@apex.com', { first: 'Jo', last: 'Jones' });
  assert.ok(matches.includes('fl'));
  assert.ok(matches.length >= 1);
});

test('best guess comes first when several formats fit', () => {
  // Someone whose first and last name are the same word: `first` and `last`
  // both explain the address, and `first` is far more common in the wild.
  const matches = matchPatterns('nair@apex.com', { first: 'Nair', last: 'Nair' });
  assert.ok(matches.includes('first'));
  assert.ok(matches.includes('last'));
  assert.equal(matches[0], 'first');
  assert.ok(matches.indexOf('first') < matches.indexOf('last'));
});

test('an address outside the set matches nothing', () => {
  // Employee-number mailboxes, seen on a real list.
  assert.deepEqual(matchPatterns('emp4417@initech.com', { first: 'Peter', last: 'Gibbons' }), []);
});

test('accented and apostrophed names match their real addresses', () => {
  assert.deepEqual(
    matchPatterns('maria.garcia@apex.com', { first: 'María', last: 'García' }),
    ['first.last'],
  );
  assert.deepEqual(
    matchPatterns('kobrien@globex.io', { first: 'Kevin', last: "O'Brien" }),
    ['flast'],
  );
});

// -------------------------------------------------------------- seeds

// Learning a format from a seed now lives in `predictor.js` as
// `patternsFromSeed`, because it needs every reading of the owner's name.
// Those tests moved to predictor.test.js with it.

test('a leading-initial owner name matches the first-name format', () => {
  // "D Bhushan" as given=D, last=Bhushan would say `last`; with the given
  // name read as Bhushan the mailbox is plainly `first`.
  assert.deepEqual(matchPatterns('bhushan@webknot.in', { first: 'Bhushan', last: 'D' }), ['first']);
});

// ---------------------------------------------------------- predicting

test('applies a learned format to someone else at the company', () => {
  const out = predict({
    patterns: ['first.last'], first: 'Rajesh', last: 'Sharma', domain: 'apex.com',
  });
  assert.deepEqual(out, [{ email: 'rajesh.sharma@apex.com', pattern: 'first.last' }]);
});

test('returns one candidate per format, best first', () => {
  const out = predict({
    patterns: ['first.last', 'flast'], first: 'Rajesh', last: 'Sharma', domain: 'apex.com',
  });
  assert.deepEqual(out.map((c) => c.email), ['rajesh.sharma@apex.com', 'rsharma@apex.com']);
});

test('skips a format this name cannot satisfy instead of failing', () => {
  const out = predict({
    patterns: ['fmlast', 'first.last'], first: 'Rajesh', last: 'Sharma', domain: 'apex.com',
  });
  assert.deepEqual(out, [{ email: 'rajesh.sharma@apex.com', pattern: 'first.last' }]);
});

test('two formats producing the same address are reported once', () => {
  const out = predict({
    patterns: ['first.last', 'first.last'], first: 'A', last: 'B', domain: 'apex.com',
  });
  assert.equal(out.length, 1);
});

test('no usable domain means no prediction', () => {
  assert.deepEqual(
    predict({ patterns: ['first.last'], first: 'A', last: 'B', domain: 'Acme Corp' }),
    [],
  );
});

// --------------------------------------------------------- confidence

test('a format we proved, on a clean name, is the top band', () => {
  const { score, band } = scoreConfidence({
    provenance: 'proven', patternCount: 1, nameConfidence: 'clean',
  });
  assert.equal(score, 1);
  assert.equal(band, 'high');
});

test('a single asserted seed is not top band - it is unconfirmed', () => {
  // 0.85: one mistyped seed must not look as good as a proven format.
  const { score, band } = scoreConfidence({ provenance: 'asserted' });
  assert.equal(score, 0.85);
  assert.equal(band, 'medium');
});

test('an ambiguous seed drops to medium, not low', () => {
  assert.equal(scoreConfidence({ provenance: 'asserted', patternCount: 2 }).band, 'medium');
  assert.equal(scoreConfidence({ provenance: 'proven', patternCount: 2 }).band, 'medium');
});

test('an uncertain name split also drops a band', () => {
  assert.equal(
    scoreConfidence({ provenance: 'asserted', nameConfidence: 'ambiguous' }).band,
    'medium',
  );
});

test('two doubts together are low', () => {
  assert.equal(
    scoreConfidence({ provenance: 'asserted', patternCount: 2, nameConfidence: 'ambiguous' }).band,
    'low',
  );
  assert.equal(scoreConfidence({ patternCount: 3 }).band, 'low');
});

test('unknown inputs fall back to the cautious weighting', () => {
  const { band } = scoreConfidence({ provenance: 'nonsense', nameConfidence: 'nonsense' });
  assert.equal(band, 'medium');
});
