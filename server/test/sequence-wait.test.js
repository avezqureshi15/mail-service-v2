// Must come first: points the app at a scratch schema.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import { queryOne, execute } from '../src/db/index.js';
import { setSettings } from '../src/db/repositories/settings.js';
import { advanceEnrollment, enrollContacts, createCampaign } from '../src/db/repositories/campaigns.js';
import { upsertContact } from '../src/db/repositories/contacts.js';

before(setupTestSchema);
after(teardownTestSchema);

/**
 * The testing switch that counts follow-up waits in minutes.
 *
 * Worth covering because getting it wrong is expensive in both directions:
 * stuck on days, a sequence cannot be tested; stuck on minutes, a live
 * campaign sends every step within the hour.
 */
async function scheduleWait(waitDays) {
  const email = `wait-${Math.random().toString(36).slice(2)}@test.example`;
  const contact = await upsertContact({ email, source: 'test' });
  const campaign = await createCampaign({ name: `c-${email}`, isSequence: true });
  await enrollContacts(campaign.id, [contact.id]);

  await advanceEnrollment({
    campaignId: campaign.id, contactId: contact.id, stepNo: 1, waitDays, threadMessageId: null,
  });

  const row = await queryOne(
    `SELECT EXTRACT(EPOCH FROM (next_run_at - now())) / 60 AS "minutesAway"
       FROM sequence_enrollments WHERE contact_id = $1`,
    [contact.id],
  );
  return Number(row.minutesAway);
}

test('by default a 3-day wait schedules three days out', async () => {
  await setSettings({ sequenceWaitUnit: 'days' });
  const minutes = await scheduleWait(3);
  assert.ok(Math.abs(minutes - 3 * 24 * 60) < 2, `expected ~4320 minutes, got ${Math.round(minutes)}`);
});

test('in testing mode the same wait schedules three minutes out', async () => {
  await setSettings({ sequenceWaitUnit: 'minutes' });
  const minutes = await scheduleWait(3);
  assert.ok(Math.abs(minutes - 3) < 2, `expected ~3 minutes, got ${Math.round(minutes)}`);
});

test('the unit is read at scheduling time, so switching back takes effect', async () => {
  await setSettings({ sequenceWaitUnit: 'minutes' });
  assert.ok(await scheduleWait(2) < 10, 'minutes while testing');

  await setSettings({ sequenceWaitUnit: 'days' });
  // A campaign scheduled after the switch must be back on real days - the
  // dangerous failure would be the flag sticking after someone turns it off.
  assert.ok(await scheduleWait(2) > 24 * 60, 'days once testing mode is off');
});

test('an unrecognised unit falls back to days rather than minutes', async () => {
  // Defensive: a hand-edited settings row must not silently accelerate a
  // live sequence. Written straight to the table, then loaded through the
  // normal path, because that is how a hand-edit would reach the cache.
  await execute(
    `INSERT INTO settings (key, value) VALUES ('sequenceWaitUnit', '"hours"')
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  const { loadSettings } = await import('../src/db/repositories/settings.js');
  await loadSettings();

  assert.ok(await scheduleWait(1) > 60, 'anything other than "minutes" means days');
  await setSettings({ sequenceWaitUnit: 'days' });
});
