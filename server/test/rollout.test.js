import test from 'node:test';
import assert from 'node:assert/strict';

import { rolloutStateFor, gateResults, gateByDomain } from '../src/lib/rollout.js';

/**
 * Probation exists to stop a format learned from one seed being used to
 * mail fifty people before anything has confirmed it. The state is derived
 * from the pattern rows rather than stored, so these tests are the whole
 * contract.
 */

const row = (over = {}) => ({
  pattern: 'first.last',
  provenance: 'asserted',
  confirmed_count: 0,
  rejected_count: 0,
  ...over,
});

const person = (name, alternatives = []) => ({
  domain: 'apex.com', inputName: name, email: `${name}@apex.com`, alternatives,
});

// --------------------------------------------------------------- state

test('a company we know nothing about is unknown', () => {
  assert.equal(rolloutStateFor([]), 'unknown');
  assert.equal(rolloutStateFor(), 'unknown');
});

test('a seed alone only gets you to probing', () => {
  assert.equal(rolloutStateFor([row()]), 'probing');
});

test('a delivery or a reply validates the company', () => {
  assert.equal(rolloutStateFor([row({ provenance: 'proven' })]), 'validated');
  assert.equal(rolloutStateFor([row({ confirmed_count: 1 })]), 'validated');
});

test('a bounce with nothing landed yet is disputed', () => {
  assert.equal(rolloutStateFor([row({ rejected_count: 1 })]), 'disputed');
});

test('a success outranks a failure elsewhere', () => {
  // Knowing the format works makes a bounce a fact about that person, not
  // about the company.
  const rows = [row({ pattern: 'flast', confirmed_count: 3 }), row({ rejected_count: 2 })];
  assert.equal(rolloutStateFor(rows), 'validated');
});

// -------------------------------------------------------------- gating

test('a validated company hands over everything', () => {
  const results = [person('a'), person('b'), person('c')];
  const { revealed, held, rollout } = gateResults({ results, state: 'validated' });

  assert.equal(revealed.length, 3);
  assert.equal(held.length, 0);
  assert.equal(rollout.probe, false);
});

test('a probing company hands over one person', () => {
  const results = [person('a'), person('b'), person('c')];
  const { revealed, held, rollout } = gateResults({ results, state: 'probing' });

  assert.deepEqual(revealed.map((r) => r.inputName), ['a']);
  assert.equal(held.length, 2);
  assert.equal(rollout.probe, true);
  assert.equal(rollout.heldPeople, 2);
  assert.match(rollout.nextAction, /unlock/);
});

test('alternatives are withheld while probing', () => {
  // Offering a second guess for the same person invites sending both,
  // which is the pattern receiving servers treat as an attack.
  const results = [person('a', [{ email: 'alt@apex.com' }, { email: 'alt2@apex.com' }])];
  const { revealed, rollout } = gateResults({ results, state: 'probing' });

  assert.deepEqual(revealed[0].alternatives, []);
  assert.equal(rollout.heldAlternatives, 2);
});

test('a disputed company is also held back', () => {
  const { rollout } = gateResults({ results: [person('a'), person('b')], state: 'disputed' });
  assert.equal(rollout.probe, true);
  assert.equal(rollout.state, 'disputed');
});

test('the operator can raise the probe budget', () => {
  const results = [person('a'), person('b'), person('c')];
  const { revealed, held } = gateResults({ results, state: 'probing', probeBudget: 2 });
  assert.equal(revealed.length, 2);
  assert.equal(held.length, 1);
});

test('a nonsense budget falls back to one rather than zero', () => {
  for (const probeBudget of [0, -5, NaN, undefined, 'x']) {
    const { revealed } = gateResults({ results: [person('a'), person('b')], state: 'probing', probeBudget });
    assert.equal(revealed.length, 1, String(probeBudget));
  }
});

test('fewer people than the budget is not an error', () => {
  const { revealed, held, rollout } = gateResults({ results: [person('a')], state: 'probing', probeBudget: 5 });
  assert.equal(revealed.length, 1);
  assert.equal(held.length, 0);
  assert.doesNotMatch(rollout.nextAction, /unlock/);
});

// ---------------------------------------------------------------- bulk

test('each company is gated on its own state', () => {
  const results = [
    { domain: 'apex.com', inputName: 'a', alternatives: [] },
    { domain: 'apex.com', inputName: 'b', alternatives: [] },
    { domain: 'globex.io', inputName: 'c', alternatives: [] },
    { domain: 'globex.io', inputName: 'd', alternatives: [] },
  ];
  const states = new Map([['apex.com', 'validated'], ['globex.io', 'probing']]);

  const { revealed, rollouts } = gateByDomain(results, states);

  assert.deepEqual(revealed.map((r) => r.inputName), ['a', 'b', 'c']);
  // Only the probing company needs reporting.
  assert.equal(rollouts.length, 1);
  assert.equal(rollouts[0].domain, 'globex.io');
});

test('companies holding the most back are listed first', () => {
  const results = [
    ...Array.from({ length: 5 }, (_, i) => ({ domain: 'big.com', inputName: `b${i}`, alternatives: [] })),
    ...Array.from({ length: 2 }, (_, i) => ({ domain: 'small.com', inputName: `s${i}`, alternatives: [] })),
  ];
  const states = new Map([['big.com', 'probing'], ['small.com', 'probing']]);

  const { rollouts } = gateByDomain(results, states);
  assert.deepEqual(rollouts.map((r) => r.domain), ['big.com', 'small.com']);
});

test('an unseen domain is treated as probing, not as open', () => {
  const results = [{ domain: 'new.com', inputName: 'a', alternatives: [] },
    { domain: 'new.com', inputName: 'b', alternatives: [] }];
  const { revealed } = gateByDomain(results, new Map());
  assert.equal(revealed.length, 1);
});
