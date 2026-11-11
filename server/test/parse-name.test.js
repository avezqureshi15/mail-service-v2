import test from 'node:test';
import assert from 'node:assert/strict';

import { parseName, nameReadings } from '../src/lib/parse-name.js';

/**
 * The awkward cases are the point. Several below came off a real prospect
 * sheet, where a "name" column holds whatever LinkedIn displayed.
 */

const split = (raw) => {
  const { first, middle, last } = parseName(raw);
  return [first, middle, last];
};

test('the ordinary case', () => {
  assert.deepEqual(split('Rajesh Sharma'), ['Rajesh', '', 'Sharma']);
});

test('a middle name lands in the middle', () => {
  assert.deepEqual(split('Rajesh Kumar Sharma'), ['Rajesh', 'Kumar', 'Sharma']);
});

test('strips a LinkedIn headline after the pipe', () => {
  assert.deepEqual(
    split('Rajesh Kumar Sharma | Scaling eng teams @ Apex'),
    ['Rajesh', 'Kumar', 'Sharma'],
  );
});

test('strips a headline introduced by a dash or a bullet', () => {
  assert.deepEqual(split('Anna Smith - Chief Technology Officer'), ['Anna', '', 'Smith']);
  assert.deepEqual(split('Anna Smith • CTO at Globex'), ['Anna', '', 'Smith']);
});

test('strips emoji and pronouns', () => {
  assert.deepEqual(split('Priya Nair 🚀 (she/her)'), ['Priya', '', 'Nair']);
});

test('drops an honorific', () => {
  assert.deepEqual(split('Dr. Priyamvada Kaushik'), ['Priyamvada', '', 'Kaushik']);
  assert.deepEqual(split('Shri Balla Praveen'), ['Balla', '', 'Praveen']);
});

test('drops trailing credentials', () => {
  assert.deepEqual(split('Sarah Lee, MBA'), ['Sarah', '', 'Lee']);
  assert.deepEqual(split('Tom Hardy PhD'), ['Tom', '', 'Hardy']);
});

test('a comma before a job title is a title, not a reversed name', () => {
  assert.deepEqual(split('Rajesh Sharma, Head of Talent'), ['Rajesh', '', 'Sharma']);
  assert.deepEqual(split('Anna Smith, VP Engineering'), ['Anna', '', 'Smith']);
});

test('a comma between two bare words is a reversed name', () => {
  assert.deepEqual(split('Sharma, Rajesh'), ['Rajesh', '', 'Sharma']);
});

test('a reversed name is flagged, because the guess could go either way', () => {
  assert.equal(parseName('Sharma, Rajesh').confidence, 'ambiguous');
  assert.equal(parseName('Rajesh Sharma').confidence, 'clean');
});

test('four or more words is flagged rather than trusted', () => {
  assert.equal(parseName('Maria Jose Garcia Lopez').confidence, 'ambiguous');
});

test('one word cannot be used', () => {
  const parsed = parseName('Rukaiya');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'single_word_name');
});

test('nothing usable is reported, not guessed', () => {
  assert.equal(parseName('').ok, false);
  assert.equal(parseName('   ').ok, false);
  assert.equal(parseName(null).reason, 'no_name');
});

// ------------------------------------------------------- alternatives

test('a bracketed nickname becomes an alternative spelling', () => {
  const parsed = parseName('Mike (Michael) Chen');
  assert.deepEqual([parsed.first, parsed.last], ['Mike', 'Chen']);
  assert.deepEqual(parsed.alternatives, [{ first: 'Michael', middle: '', last: 'Chen' }]);
});

test('a quoted nickname does the same', () => {
  const parsed = parseName('John "Jack" Smith');
  assert.ok(parsed.alternatives.some((a) => a.first === 'Jack'));
});

test('two capitals are read as initials as well as a name', () => {
  // From a real list: the mailbox was ajkhan@, which only `fmlast` on
  // first=A middle=J reaches.
  const readings = nameReadings('AJ Khan');
  assert.deepEqual(readings[0], { first: 'AJ', middle: '', last: 'Khan' });
  assert.deepEqual(readings[1], { first: 'A', middle: 'J', last: 'Khan' });
});

test('a lone leading letter is also read as an initial, not the given name', () => {
  // From a real seed: "D Bhushan" with bhushan@webknot.in. The plain split
  // (first=D) would teach the company's format as `last`.
  const parsed = parseName('D Bhushan');
  assert.deepEqual([parsed.first, parsed.middle, parsed.last], ['D', '', 'Bhushan']);
  assert.deepEqual(parsed.alternatives, [{ first: 'Bhushan', middle: '', last: 'D' }]);
});

test('readings come back best first, and empty when unusable', () => {
  assert.deepEqual(nameReadings('Rajesh Sharma'), [
    { first: 'Rajesh', middle: '', last: 'Sharma' },
  ]);
  assert.deepEqual(nameReadings('Rukaiya'), []);
});

test('a pronoun aside never becomes a nickname', () => {
  assert.deepEqual(parseName('Priya Nair (she/her)').alternatives, []);
  assert.deepEqual(parseName('Sam Taylor (they/them)').alternatives, []);
});
