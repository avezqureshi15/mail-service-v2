import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyBounceReason, demotesFormat } from '../src/lib/bounce-reason.js';

/**
 * The whole point of this module is the tri-state. A format may only be
 * demoted when the bounce actually says the address is wrong - the common
 * failure is to treat every 5.x.x as proof and retire a working format
 * because a receiving server did not like our reputation that morning.
 */

const of = (input) => classifyBounceReason(input);

// ------------------------------------------------- the address is wrong

test('user unknown is evidence about the address', () => {
  const r = of({ dsnStatus: '5.1.1' });
  assert.equal(r.type, 'hard');
  assert.equal(r.reason, 'user_unknown');
  assert.equal(r.learnsAddress, true);
  assert.equal(demotesFormat(r), true);
});

test('a malformed-address rejection is too', () => {
  assert.equal(of({ dsnStatus: '5.1.3' }).learnsAddress, true);
});

test('and so is the text form, when there is no DSN', () => {
  for (const text of [
    'no such user here',
    '550 5.1.1 <a@b.com>: Recipient address rejected: User unknown',
    'invalid recipient',
  ]) {
    assert.equal(of({ text }).learnsAddress, true, text);
  }
});

// ------------------------------------------- nothing to do with the address

test('a policy or spam block never demotes a format', () => {
  for (const dsnStatus of ['5.7.1', '5.7.0', '5.7.13']) {
    const r = of({ dsnStatus });
    assert.equal(r.reason, 'policy_block');
    assert.equal(r.learnsAddress, false);
    assert.equal(demotesFormat(r), false);
  }
});

test('an authentication failure never demotes a format', () => {
  const r = of({ dsnStatus: '5.7.26' });
  assert.equal(r.reason, 'auth_failure');
  assert.equal(demotesFormat(r), false);
});

test('a routing failure is about the domain, not the mailbox', () => {
  for (const dsnStatus of ['5.4.1', '5.4.4', '5.1.2']) {
    assert.equal(of({ dsnStatus }).reason, 'domain_unreachable');
    assert.equal(of({ dsnStatus }).learnsAddress, false);
  }
});

test('a full mailbox proves the mailbox exists', () => {
  const r = of({ dsnStatus: '5.2.2' });
  assert.equal(r.reason, 'mailbox_full');
  assert.equal(r.type, 'soft');
  assert.equal(r.learnsAddress, false);
});

// ------------------------------------------------------------- unclear

test('a disabled or moved mailbox is unclear, not proof', () => {
  // It may have been right and the person left. Record it; do not act.
  for (const dsnStatus of ['5.2.1', '5.1.6']) {
    const r = of({ dsnStatus });
    assert.equal(r.reason, 'mailbox_unavailable');
    assert.equal(r.learnsAddress, null);
    assert.equal(demotesFormat(r), false);
  }
});

test('anything transient is never evidence', () => {
  const r = of({ dsnStatus: '4.3.2' });
  assert.equal(r.type, 'soft');
  assert.equal(r.learnsAddress, null);
});

test('a bare 5xx code is permanent but unexplained', () => {
  const r = of({ smtpCode: '550' });
  assert.equal(r.type, 'hard');
  assert.equal(r.learnsAddress, null);
  // 550 is usually "no such user" but is also what a content filter sends,
  // so on its own it must not retire a format.
  assert.equal(demotesFormat(r), false);
});

// --------------------------------------------------------- not a bounce

test('an out-of-office is not a bounce', () => {
  for (const text of [
    'I am out of office until Monday',
    'Automatic reply: I am on leave this week',
    'Thank you for your email. I will get back to you shortly.',
  ]) {
    const r = of({ text });
    assert.equal(r.type, 'auto_reply', text);
    assert.equal(r.learnsAddress, false);
  }
});

test('a real bounce quoting an out-of-office is still a bounce', () => {
  // The DSN status decides; the quoted body must not override it.
  const r = of({
    dsnStatus: '5.1.1',
    text: 'Original message said: I am out of office until Monday',
  });
  assert.equal(r.type, 'hard');
  assert.equal(r.learnsAddress, true);
});

// --------------------------------------------------------------- misc

test('nothing recognisable is unknown, and acts on nothing', () => {
  const r = of({ text: 'something went wrong somewhere' });
  assert.equal(r.type, 'unknown');
  assert.equal(r.learnsAddress, null);
  assert.equal(demotesFormat(r), false);
});

test('empty input does not throw', () => {
  assert.equal(of({}).type, 'unknown');
  assert.equal(classifyBounceReason({}).reason, 'unknown');
});

test('the DSN status is carried through as the code', () => {
  assert.equal(of({ dsnStatus: '5.1.1' }).code, '5.1.1');
  assert.equal(of({ smtpCode: 'smtp; 452 too many' }).code, '452');
});
