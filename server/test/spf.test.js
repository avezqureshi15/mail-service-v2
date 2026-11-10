import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpf, detectProviders, chainAuthorises, PROVIDER_PATTERNS } from '../src/lib/spf.js';

/**
 * These run against live DNS on purpose. The parser's job is to be right
 * about records that actually exist, and the two bugs it has already had -
 * counting `~all` as an `a` lookup, and treating a nested include as if it
 * sat on the root record - only showed up against a real multi-provider
 * domain.
 */

test('counts only genuine DNS-querying mechanisms, not the all mechanism', async () => {
  // google.com: one include plus ip4/ip6 literals and a trailing ~all.
  const spf = await resolveSpf('_spf.google.com');
  assert.equal(spf.found, true);
  // All terms here are ip4/ip6 or ~all, so nothing should be counted.
  assert.equal(spf.lookups, 0, `expected 0 lookups, counted ${spf.lookups}`);
  assert.ok(spf.ipMechanisms > 0, 'ip4/ip6 mechanisms should be tallied separately');
});

test('walks an include chain and finds providers nested below the root', async () => {
  // webknot.in authorises Google via an SPF-management include, so a flat
  // match on the root record would miss it entirely.
  const spf = await resolveSpf('webknot.in');
  assert.equal(spf.found, true);
  assert.ok(spf.chain.length >= 2, 'should have descended into the include');
  assert.ok(
    chainAuthorises(spf, PROVIDER_PATTERNS.google),
    'Google is authorised one level down and must be detected',
  );
  assert.ok(detectProviders(spf).includes('google'));
});

test('separates root-level includes from nested ones', async () => {
  const spf = await resolveSpf('webknot.in');
  // Everything reachable in the chain.
  assert.ok(spf.includes.length > spf.rootIncludes.length,
    'nested includes should appear in includes but not rootIncludes');
  // Only what is editable on the root record. Re-stating a nested include at
  // the root would waste one of the ten lookups for no benefit.
  assert.ok(spf.rootIncludes.every((i) => spf.root.includes(`include:${i}`)),
    'every rootInclude must literally appear in the root record');
  assert.ok(!spf.rootIncludes.includes('_spf.google.com'),
    'a nested include must not be reported as a root include');
});

test('lookup count stays within the RFC limit for a real domain', async () => {
  const spf = await resolveSpf('webknot.in');
  // Three records in the chain each end in ~all; the old parser counted each
  // as an `a` mechanism and reported 5 instead of 2.
  assert.ok(spf.lookups <= 3, `expected a small lookup count, got ${spf.lookups}`);
});

test('reports a missing SPF record rather than throwing', async () => {
  const spf = await resolveSpf('no-such-domain-xyz-99812.invalid');
  assert.equal(spf.found, false);
  assert.equal(spf.root, null);
});
