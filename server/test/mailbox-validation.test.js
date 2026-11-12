// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import { applyPreset, validateMailbox, tlsHint } from '../src/routes/mailboxes.js';

/**
 * The checks that stop a mailbox being saved into a state which only fails
 * later, as something that reads like a different problem entirely.
 *
 * A transposed digit in a port is the easiest mistake to make in this form
 * and the hardest to read back: nothing listens on 455 or 986, so the single
 * symptom is "Connection timeout" - which looks like a firewall, or a wrong
 * password, or antivirus interference. Anything but the typo it is.
 */

before(setupTestSchema);
after(teardownTestSchema);

/** Runs a form body through the same path the route uses. */
function check(body) {
  const full = {
    label: 'Test', provider: 'zoho', fromName: 'T',
    fromEmail: 'a@example.test', replyTo: '', imapEnabled: false,
    ...body,
  };
  const { preset, values } = applyPreset(full);
  return validateMailbox({ preset, values, body: full, existing: null });
}

test('a transposed SMTP port is refused, not left to time out later', () => {
  const result = check({ smtpPort: 455 });
  assert.ok(result, 'port 455 should not be accepted for a known provider');
  assert.match(result.error, /465 or 587, not 455/);
});

test('a transposed IMAP port is refused', () => {
  const result = check({
    imapEnabled: true,
    imapPort: 986,
    imapHost: 'imappro.zoho.in',
    imapPassword: 'x',
  });
  assert.ok(result, 'port 986 should not be accepted');
  assert.match(result.error, /993, not 986/);
});

test('both standard SMTP ports are allowed', () => {
  assert.equal(check({ smtpPort: 465 }), null);
  assert.equal(check({ smtpPort: 587 }), null);
});

test('mixing data centres between SMTP and IMAP is refused', () => {
  // A mailbox lives in exactly one Zoho data centre. A .com SMTP host beside
  // a .in IMAP host means one of them is wrong, and the SPF include can only
  // match whichever actually sends.
  const result = check({
    smtpHost: 'smtppro.zoho.com',
    imapEnabled: true,
    imapHost: 'imappro.zoho.in',
    imapPassword: 'x',
  });
  assert.ok(result, 'a .com/.in split should be refused');
  assert.match(result.error, /data centre/);
});

test('matching data centres are fine', () => {
  const result = check({
    region: 'in',
    smtpHost: 'smtppro.zoho.in',
    imapEnabled: true,
    imapHost: 'imappro.zoho.in',
    imapPassword: 'x',
  });
  assert.equal(result, null);
});

test('an unknown provider keeps its freedom to use an odd port', () => {
  // Only the presets have known-good ports. A self-hosted or niche server
  // may legitimately listen somewhere else, so "other" is left alone.
  const result = check({ provider: 'other', smtpHost: 'mail.example.test', smtpPort: 2525 });
  assert.equal(result, null);
});

test('Gmail still refuses a From that does not match the authenticated mailbox', () => {
  const result = check({
    provider: 'google',
    fromEmail: 'someone@example.test',
    smtpUser: 'other@example.test',
    smtpPort: 465,
  });
  assert.ok(result);
  assert.match(result.error, /authenticated mailbox/);
});


/**
 * The hint attached to a failed connection test.
 *
 * imapflow reduces anything the server refused to "Command failed" and puts
 * the server's own sentence in `responseText`. Reading only the message loses
 * the answer and leaves the hint guessing - which is worse than no hint,
 * because it sends someone to regenerate a password that was never wrong.
 */
test('a disabled protocol is not reported as a credentials problem', () => {
  const hint = tlsHint({
    message: 'Command failed',
    responseText: 'You are yet to enable IMAP for your account. Please contact your administrator (Failure)',
    // imapflow sets this even though the password was accepted.
    authenticationFailed: true,
  });
  assert.match(hint, /switched off|enable IMAP access/i);
  assert.doesNotMatch(hint, /rejected the credentials/i);
});

test('a genuinely rejected password still reports as credentials', () => {
  const hint = tlsHint({
    message: 'Command failed',
    responseText: 'Invalid credentials',
    authenticationFailed: true,
  });
  assert.match(hint, /rejected the credentials/i);
});

test('a timeout points at the port before blaming the network', () => {
  const hint = tlsHint({ message: 'Connection timeout', code: 'ETIMEDOUT' });
  assert.match(hint, /port/i);
  assert.match(hint, /465|993/);
});

test('an intercepted certificate is named as interception', () => {
  const hint = tlsHint({
    message: 'self-signed certificate in certificate chain',
    code: 'SELF_SIGNED_CERT_IN_CHAIN',
  });
  assert.match(hint, /intercepting|antivirus|proxy/i);
});
