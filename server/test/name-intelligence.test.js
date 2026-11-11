import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichNames, readingsFor, needsModel } from '../src/lib/name-intelligence.js';
import { extractJson } from '../src/lib/llm.js';

/**
 * The model is injected, so these run offline, cost nothing and are
 * deterministic. What is being tested is not the model - it is the
 * validation around it, which is the part that has to hold when the model
 * returns something odd.
 *
 * `enrichNames` is a no-op unless LLM_API_KEY is set, so the tests that
 * exercise a response stub `isEnabled` indirectly by going through
 * `readingsFor`, which takes a map and needs no key.
 */

// ------------------------------------------------------------- json

test('reads plain json', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('reads json out of a fenced block', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('reads json with a sentence in front of it', () => {
  assert.deepEqual(extractJson('Here you go: {"a":1}'), { a: 1 });
});

test('returns null rather than throwing on nonsense', () => {
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

// ------------------------------------------------------- which to send

test('a plain two-word name does not need the model', () => {
  assert.equal(needsModel('Anna Smith'), false);
  assert.equal(needsModel('John Doe'), false);
});

test('names the rules flagged do need it', () => {
  assert.equal(needsModel('Sharma, Rajesh'), true);
  assert.equal(needsModel('Maria Jose Garcia Lopez'), true);
});

test('a leading single letter needs it - it may be a village or father initial', () => {
  assert.equal(needsModel('D Bhushan'), true);
});

test('a long given name is worth asking about - it is the one that gets shortened', () => {
  assert.equal(needsModel('Krishnamurthy Iyer'), true);
  assert.equal(needsModel('Venkatesh Rao'), true);
});

test('a wholly non-Latin name is parsed, not thrown away', async () => {
  // It used to vanish: the word filter tested [a-z], so every token was
  // dropped and the row came back as "no name found".
  const { parseName } = await import('../src/lib/parse-name.js');
  assert.equal(parseName('李 伟').ok, true);
  assert.equal(parseName('राजेश शर्मा').ok, true);
});

test('but it is not sent to the model, because the answer is unusable', async () => {
  // An address needs Latin characters, so this would need transliteration -
  // a new string, which validate() refuses by design. The row is reported
  // as unbuildable rather than costing a call that gets discarded.
  assert.equal(needsModel('李 伟'), false);

  const { predictRows } = await import('../src/lib/predictor.js');
  const { skipped } = predictRows(
    [{ name: '李 伟', domain: 'apex.com' }],
    new Map([['apex.com', { patterns: ['first.last'], provenance: 'proven' }]]),
  );
  assert.equal(skipped[0].reason, 'unbuildable');
});

// ------------------------------------------------------------ readings

const enrichmentOf = (raw, value) => new Map([[raw, value]]);

test('the model\'s reading leads, the rules\' reading is kept behind it', () => {
  // The case this exists for: rules say the surname is Praveen, the model
  // says the family name is Balla.
  const readings = readingsFor('Balla Praveen', enrichmentOf('Balla Praveen', {
    first: 'Praveen', middle: '', last: 'Balla', shortForms: [],
  }));

  assert.deepEqual(readings[0], { first: 'Praveen', middle: '', last: 'Balla', speculative: false });
  assert.deepEqual(readings[1], { first: 'Balla', middle: '', last: 'Praveen', speculative: false });
  // Both are real answers about who this person is, so both count as doubt.
  assert.equal(readings.filter((r) => !r.speculative).length, 2);
});

test('short forms come after the full name, and are marked speculative', () => {
  const readings = readingsFor('Venkatesh Rao', enrichmentOf('Venkatesh Rao', {
    first: 'Venkatesh', middle: '', last: 'Rao', shortForms: ['venkat'],
  }));

  assert.deepEqual(readings[0], { first: 'Venkatesh', middle: '', last: 'Rao', speculative: false });

  const short = readings.find((r) => r.first === 'venkat');
  assert.equal(short.last, 'Rao');
  // The crux: a nickname existing must not make the main answer look
  // uncertain, so exactly one reading counts towards ambiguity.
  assert.equal(short.speculative, true);
  assert.equal(readings.filter((r) => !r.speculative).length, 1);
});

test('with no enrichment it is exactly the rules', () => {
  const expected = [{ first: 'Rajesh', middle: '', last: 'Sharma', speculative: false }];
  assert.deepEqual(readingsFor('Rajesh Sharma', null), expected);
  assert.deepEqual(readingsFor('Rajesh Sharma', new Map()), expected);
});

test('a nickname is a real alternative, a short form is not', () => {
  // "Mike (Michael) Chen" could genuinely be either person; "venkat" is the
  // same person written shorter. They must be weighted differently.
  const bracketed = readingsFor('Mike (Michael) Chen', null);
  assert.equal(bracketed.filter((r) => !r.speculative).length, 2);
});

test('duplicate readings are not repeated', () => {
  // Model agrees with the rules - one reading, not two.
  const readings = readingsFor('Anna Smith', enrichmentOf('Anna Smith', {
    first: 'Anna', middle: '', last: 'Smith', shortForms: [],
  }));
  assert.equal(readings.length, 1);
});

test('an unusable name yields no readings at all', () => {
  assert.deepEqual(readingsFor('Rukaiya', null), []);
  assert.deepEqual(readingsFor('', null), []);
});

// ------------------------------------------------- validating the model

/** An injected chat always runs, so these need no key and make no network call. */
const enrich = (names, reply) => enrichNames(names, { chat: async () => reply });

test('reordering the operator\'s own words is accepted', async () => {
  const out = await enrich(['Balla Praveen'], {
    names: [{ i: 0, given: 'Praveen', family: 'Balla', short: [] }],
  });
  assert.equal(out.get('Balla Praveen').first, 'Praveen');
  assert.equal(out.get('Balla Praveen').last, 'Balla');
  // Flagged, because disagreeing with the rules is the whole reason to ask.
  assert.equal(out.get('Balla Praveen').swapped, true);
});

test('a surname the operator never supplied is discarded', async () => {
  const out = await enrich(['Anna Smith'], {
    names: [{ i: 0, given: 'Anna', family: 'Rodriguez', short: [] }],
  });
  assert.equal(out.has('Anna Smith'), false);
});

test('an address in the name fields is discarded', async () => {
  const out = await enrich(['Anna Smith'], {
    names: [{ i: 0, given: 'anna@smith.com', family: 'Smith', short: [] }],
  });
  assert.equal(out.has('Anna Smith'), false);
});

test('a one-word name echoed back as both halves is discarded', async () => {
  const out = await enrich(['Rukaiya'], {
    names: [{ i: 0, given: 'Rukaiya', family: 'Rukaiya', short: [] }],
  });
  assert.equal(out.has('Rukaiya'), false);
});

test('short forms are capped, lowercased and sanity-checked', async () => {
  const out = await enrich(['Krishnamurthy Iyer'], {
    names: [{
      i: 0,
      given: 'Krishnamurthy',
      family: 'Iyer',
      short: ['Krishna', 'KRISH', 'k', 'bad@one', 'kittu', 'extra', 'more'],
    }],
  });
  const { shortForms } = out.get('Krishnamurthy Iyer');
  assert.deepEqual(shortForms, ['krishna', 'krish', 'kittu']);
});

test('a malformed response leaves the rules in charge', async () => {
  for (const reply of [null, {}, { names: 'nope' }, { names: [{ i: 99 }] }]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await enrich(['Anna Smith'], reply);
    assert.equal(out.size, 0);
  }
});

test('a bare array is accepted as well as {names:[...]}', async () => {
  const out = await enrich(['Balla Praveen'], [
    { i: 0, given: 'Praveen', family: 'Balla', short: [] },
  ]);
  assert.equal(out.get('Balla Praveen').last, 'Balla');
});

test('with no model configured, nothing is called', async () => {
  // `enabled: false` rather than relying on the machine having no key -
  // this test used to pass only on an unconfigured box, and started making
  // a real network call the moment a key was added.
  const out = await enrichNames(['Anna Smith'], { enabled: false });
  assert.equal(out.size, 0);
});

test('a configured model with no injected chat still never runs here', async () => {
  // Guards the seam itself: if `chat` were ever ignored, the rest of this
  // file would silently start calling the live API.
  let called = false;
  await enrichNames(['Anna Smith'], {
    enabled: true,
    chat: async () => { called = true; return null; },
  });
  assert.equal(called, true);
});

test('a model reading flows through to the addresses predicted', async () => {
  const { predictRows } = await import('../src/lib/predictor.js');
  const enrichment = await enrich(['Balla Praveen'], {
    names: [{ i: 0, given: 'Praveen', family: 'Balla', short: ['prav'] }],
  });

  const { results } = predictRows(
    [{ name: 'Balla Praveen', domain: 'apex.com' }],
    new Map([['apex.com', { patterns: ['first.last'], provenance: 'proven' }]]),
    { enrichment },
  );

  // The model's reading leads; the rules' reading survives as an alternative.
  assert.equal(results[0].email, 'praveen.balla@apex.com');
  const alternatives = results[0].alternatives.map((a) => a.email);
  assert.ok(alternatives.includes('prav.balla@apex.com'));
  assert.ok(alternatives.includes('balla.praveen@apex.com'));
});
