import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Authenticated encryption for the credentials held in the database.
 *
 * SMTP and IMAP passwords used to live in .env, where the filesystem was the
 * only thing guarding them. Moving them into Postgres means a database dump,
 * a backup file or a read-only SQL console would otherwise hand over every
 * sending account at once - so they are sealed before they are stored and
 * opened only at the moment a connection is built.
 *
 * GCM rather than plain CBC because it authenticates as well as encrypts: a
 * row that has been tampered with, or one encrypted under a key that has
 * since been rotated, fails loudly on `open()` instead of quietly yielding
 * garbage that we would then try to authenticate to Zoho with.
 */

const ALGORITHM = 'aes-256-gcm';
// 96 bits is the size GCM is specified around; longer IVs get hashed down and
// buy nothing.
const IV_BYTES = 12;
const KEY_BYTES = 32;
// Prefixed on every value so a future algorithm change can be told apart from
// a corrupt row, and old rows can still be read while they are re-sealed.
const VERSION = 'v1';

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;

  const raw = Buffer.from(env.SECRETS_KEY, 'hex');
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_KEY must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters `
      + `(got ${raw.length}). Generate one with: `
      + 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  cachedKey = raw;
  return cachedKey;
}

/**
 * Encrypts a credential for storage.
 *
 * @param {string} plaintext
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export function seal(plaintext) {
  const value = String(plaintext ?? '');
  if (value === '') throw new Error('Refusing to seal an empty secret');

  // A fresh IV per call. Reusing one across two values under the same key is
  // the one mistake that breaks GCM completely.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a stored credential.
 *
 * Throws on a wrong key, a truncated value or any modification - `final()`
 * verifies the GCM tag and refuses rather than returning plaintext.
 */
export function open(sealed) {
  const parts = String(sealed ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored secret is not in the expected format');
  }

  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately not forwarding the underlying message, which varies by
    // OpenSSL build and says nothing useful here.
    throw new Error(
      'Could not decrypt a stored secret. SECRETS_KEY does not match the key '
      + 'this value was sealed with, or the row has been altered.',
    );
  }
}

/** True when a value looks like something `open()` could accept. */
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}
