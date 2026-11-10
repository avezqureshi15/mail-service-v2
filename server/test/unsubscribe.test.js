// Must come first: points the app at a scratch schema before env.js reads
// the configuration.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import { queryOne } from '../src/db/index.js';
import { applyUnsubscribe } from '../src/lib/apply-unsubscribe.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { isSuppressed } from '../src/db/repositories/suppressions.js';

before(setupTestSchema);
after(teardownTestSchema);

/**
 * Unsubscribe must never fail.
 *
 * Someone who clicks Unsubscribe and gets an error page reports the message
 * as spam instead, which is the single most damaging signal a sender can
 * collect - so these cover the inputs that previously threw.
 */

const unsubscribed = (email) => queryOne('SELECT * FROM unsubscribes WHERE email = $1', [email]);

test('works when the token carries ids that do not exist', async () => {
  // Exactly the failure seen in the wild: a test send minted a token with
  // contact 0 and campaign 0, and the foreign key rejected the insert.
  const email = 'phantom@webknot.test';
  await upsertContact({ email, source: 'test' });

  await assert.doesNotReject(() => applyUnsubscribe({
    email, contactId: 0, campaignId: 0, method: 'link', ip: '', userAgent: '',
  }));

  assert.equal(await isSuppressed(email), true, 'the address must still be suppressed');

  const row = await unsubscribed(email);
  assert.ok(row, 'the opt-out must still be recorded');
  assert.equal(row.campaign_id, null, 'a campaign that does not exist is stored as null');
  assert.ok(row.contact_id, 'the contact should be resolved by email instead');
});

test('works for an address with no contact record at all', async () => {
  const email = 'stranger@webknot.test';

  await assert.doesNotReject(() => applyUnsubscribe({
    email, contactId: null, campaignId: null, method: 'one_click', ip: '', userAgent: '',
  }));

  assert.equal(await isSuppressed(email), true);
  const row = await unsubscribed(email);
  assert.equal(row.contact_id, null);
  assert.equal(row.method, 'one_click');
});

test('works when the campaign was deleted after the email went out', async () => {
  const email = 'stale@webknot.test';
  const contact = await upsertContact({ email, source: 'test' });

  await assert.doesNotReject(() => applyUnsubscribe({
    email, contactId: contact.id, campaignId: 999999, method: 'link', ip: '', userAgent: '',
  }));

  assert.equal(await isSuppressed(email), true);
  assert.equal((await unsubscribed(email)).campaign_id, null);
});

test('a stale contact id falls back to the address', async () => {
  const email = 'moved@webknot.test';
  const contact = await upsertContact({ email, source: 'test' });

  await applyUnsubscribe({
    email, contactId: 888888, campaignId: null, method: 'link', ip: '', userAgent: '',
  });

  assert.equal((await unsubscribed(email)).contact_id, contact.id);
});

test('real ids are preserved when they do exist', async () => {
  const email = 'genuine@webknot.test';
  const contact = await upsertContact({ email, source: 'test' });
  const { id: campaignId } = await queryOne(
    "INSERT INTO campaigns (name, subject) VALUES ('t', 's') RETURNING id",
  );

  await applyUnsubscribe({
    email, contactId: contact.id, campaignId, method: 'link', ip: '1.2.3.4', userAgent: 'x',
  });

  const row = await unsubscribed(email);
  assert.equal(row.contact_id, contact.id);
  assert.equal(row.campaign_id, campaignId, 'provenance is kept when it is real');
  assert.equal(row.ip, '1.2.3.4');
});

test('unsubscribing twice does not throw', async () => {
  const email = 'twice@webknot.test';
  await upsertContact({ email, source: 'test' });

  const once = () => applyUnsubscribe({
    email, contactId: null, campaignId: null, method: 'link', ip: '', userAgent: '',
  });

  await assert.doesNotReject(once);
  // Mail clients sometimes POST the one-click URL more than once.
  await assert.doesNotReject(once);
  assert.equal(await isSuppressed(email), true);
});
