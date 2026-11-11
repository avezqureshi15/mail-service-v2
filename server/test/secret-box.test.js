// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { seal, open, isSealed } from '../src/lib/secret-box.js';

/**
 * The stored-credential seal.
 *
 * These are the properties the whole mailbox feature rests on: a password
 * that goes into the database comes back out intact, and anything that has
 * been altered or was sealed under a different key fails loudly instead of
 * producing plausible rubbish that we would then try to log in with.
 */

test('a sealed secret round-trips', () => {
  const secret = 'abcd efgh ijkl mnop';
  assert.equal(open(seal(secret)), secret);
});

test('sealing is non-deterministic, so equal passwords do not look equal at rest', () => {
  // A fresh IV per call. Without it, two mailboxes sharing a password would
  // be visibly identical in a database dump.
  assert.notEqual(seal('same-password'), seal('same-password'));
});

test('unicode and long secrets survive intact', () => {
  const secret = `p${'ä'.repeat(50)}ssword-\u{1F510}`;
  assert.equal(open(seal(secret)), secret);
});

/**
 * Flips one bit of a base64url field, at the byte level.
 *
 * Editing the encoded characters directly is not reliable: the final
 * character of a base64 group carries padding bits, so changing it can
 * decode to exactly the same bytes and the tamper silently does nothing.
 */
function flipByte(sealed, fieldIndex) {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[fieldIndex], 'base64url');
  bytes[0] ^= 0xff;
  parts[fieldIndex] = bytes.toString('base64url');
  return parts.join('.');
}

test('a tampered ciphertext is refused, not decrypted', () => {
  assert.throws(() => open(flipByte(seal('original-password'), 3)), /Could not decrypt/);
});

test('a tampered auth tag is refused', () => {
  assert.throws(() => open(flipByte(seal('original-password'), 2)), /Could not decrypt/);
});

test('a tampered IV is refused', () => {
  assert.throws(() => open(flipByte(seal('original-password'), 1)), /Could not decrypt/);
});

test('a value that is not sealed at all is rejected on shape', () => {
  assert.throws(() => open('plaintext-password'), /not in the expected format/);
  assert.throws(() => open(''), /not in the expected format/);
  assert.throws(() => open(null), /not in the expected format/);
});

test('an empty secret is refused rather than sealed', () => {
  // A blank password field means "leave the stored one alone"; sealing the
  // empty string would lock the mailbox out on its next send.
  assert.throws(() => seal(''), /empty secret/);
});

test('isSealed distinguishes stored ciphertext from a typed password', () => {
  assert.equal(isSealed(seal('x')), true);
  assert.equal(isSealed('hunter2'), false);
  assert.equal(isSealed(null), false);
});
