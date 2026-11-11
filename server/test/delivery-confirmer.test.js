// Must come first: points the app at a scratch schema.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema, makeTestMailbox } from './helpers/test-db.js';
import { query, queryOne, execute } from '../src/db/index.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { createCampaign } from '../src/db/repositories/campaigns.js';
import { suppress } from '../src/db/repositories/suppressions.js';
import {
  savePredictions, recordPattern, recordPredictionEvent, patternsForDomain,
} from '../src/db/repositories/predictions.js';
import { confirmQuietDeliveries } from '../src/workers/delivery-confirmer.js';

let watchedMailbox;

before(async () => {
  await setupTestSchema();
  // Confirmation is only valid for a mailbox that actually watches its
  // inbox - silence from one with IMAP off proves nothing.
  watchedMailbox = await makeTestMailbox({ imapEnabled: true, isDefault: true });
});
after(teardownTestSchema);

/**
 * The sweep is what stops probation being a one-way door: without it only a
 * reply ever promotes a company, and cold reply rates are a few percent.
 *
 * Everything it must refuse to confirm is as important as what it confirms,
 * because a false confirmation teaches a wrong format as right.
 */

let seq = 0;

/** A contact who was predicted, mailed, and has been quiet ever since. */
async function scenario({
  domain = `co${seq}.test`,
  pattern = 'first.last',
  sentHoursAgo = 72,
  sent = true,
  mailboxId = null,
} = {}) {
  seq += 1;
  const email = `person${seq}@${domain}`;

  const contact = await upsertContact({
    email, firstName: 'Test', lastName: `Person${seq}`, source: 'test',
  });
  const campaign = await createCampaign({ name: `camp-${seq}` });

  if (sent) {
    await execute(
      `INSERT INTO send_jobs (campaign_id, contact_id, step_no, status, message_id, sent_at, mailbox_id)
       VALUES ($1, $2, 1, 'sent', $3, now() - make_interval(hours => $4), $5)`,
      [campaign.id, contact.id, `<msg-${seq}@test>`, sentHoursAgo, mailboxId ?? watchedMailbox.id],
    );
  }

  await recordPattern({ domain, pattern, provenance: 'asserted', learnedFrom: email });
  await savePredictions([{
    domain,
    input_name: `Test Person${seq}`,
    first_name: 'Test',
    last_name: `Person${seq}`,
    predicted_email: email,
    pattern,
    confidence: 0.85,
    band: 'high',
  }]);

  const prediction = await queryOne(
    'SELECT * FROM email_predictions WHERE lower(predicted_email) = $1', [email],
  );
  return { email, domain, pattern, contact, campaign, prediction };
}

const eventsFor = (id) =>
  query('SELECT * FROM prediction_events WHERE prediction_id = $1', [id]);

// ------------------------------------------------------------- confirms

test('silence from a mailbox with IMAP off is never read as delivery', async () => {
  // The whole mechanism rests on bounces being detected: a quiet send only
  // means something if someone was listening. A mailbox with IMAP off hears
  // nothing, so its silence is absence of evidence, and confirming on it
  // would teach the predictor a wrong format as right.
  const blind = await makeTestMailbox({ imapEnabled: false });
  const s = await scenario({ mailboxId: blind.id });

  const { confirmed } = await confirmQuietDeliveries({ afterHours: 48 });

  const events = await eventsFor(s.prediction.id);
  assert.equal(events.length, 0, 'a blind mailbox must produce no evidence');

  const after = await queryOne(
    'SELECT outcome FROM email_predictions WHERE id = $1', [s.prediction.id],
  );
  assert.notEqual(after.outcome, 'accepted', 'unconfirmable send was confirmed anyway');
  assert.ok(confirmed >= 0);
});


test('a quiet send past the window is confirmed as delivered', async () => {
  const s = await scenario();

  const { confirmed } = await confirmQuietDeliveries({ afterHours: 48 });
  assert.ok(confirmed >= 1);

  const events = await eventsFor(s.prediction.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'accepted');

  const after = await queryOne(
    'SELECT outcome FROM email_predictions WHERE id = $1', [s.prediction.id],
  );
  assert.equal(after.outcome, 'delivered');
});

test('delivery counts as evidence but does not prove the format', async () => {
  // A catch-all domain produces exactly this signal for every address, so
  // silence must not earn the same weight as a reply.
  const s = await scenario();
  await confirmQuietDeliveries({ afterHours: 48 });

  const [row] = await patternsForDomain(s.domain);
  assert.equal(row.confirmed_count, 1);
  assert.equal(row.provenance, 'asserted');
});

test('running twice confirms once', async () => {
  const s = await scenario();

  await confirmQuietDeliveries({ afterHours: 48 });
  await confirmQuietDeliveries({ afterHours: 48 });

  assert.equal((await eventsFor(s.prediction.id)).length, 1);
  const [row] = await patternsForDomain(s.domain);
  assert.equal(row.confirmed_count, 1);
});

// -------------------------------------------------------------- refuses

test('a send still inside the window is left alone', async () => {
  const s = await scenario({ sentHoursAgo: 6 });
  await confirmQuietDeliveries({ afterHours: 48 });
  assert.equal((await eventsFor(s.prediction.id)).length, 0);
});

test('a prediction that was never mailed proves nothing', async () => {
  // Age alone is not evidence - confirming this would manufacture a
  // delivery out of inactivity.
  const s = await scenario({ sent: false });
  await confirmQuietDeliveries({ afterHours: 48 });
  assert.equal((await eventsFor(s.prediction.id)).length, 0);
});

test('an address that already bounced is never confirmed', async () => {
  const s = await scenario();
  await recordPredictionEvent({
    predictionId: s.prediction.id,
    email: s.email,
    eventType: 'bounce',
    reason: 'user_unknown',
    dsnStatus: '5.1.1',
    learnsAddress: true,
    messageId: `<bounce-${s.email}>`,
  });

  await confirmQuietDeliveries({ afterHours: 48 });

  const types = (await eventsFor(s.prediction.id)).map((e) => e.event_type);
  assert.deepEqual(types, ['bounce']);
});

test('a bounce logged only in the bounces table also blocks it', async () => {
  // The bounce row can land before the prediction event is written, and
  // they are not the same table - checking only one would confirm an
  // address we already know is dead.
  const s = await scenario();
  await execute(
    `INSERT INTO bounces (message_id, email, bounce_type, smtp_code, diagnostic)
     VALUES ($1, $2, 'hard', '550', 'user unknown')`,
    [`<b-${seq}@test>`, s.email],
  );

  await confirmQuietDeliveries({ afterHours: 48 });
  assert.equal((await eventsFor(s.prediction.id)).length, 0);
});

test('a suppressed address is never confirmed', async () => {
  const s = await scenario();
  await suppress({ email: s.email, reason: 'hard_bounce', source: 'test' });

  await confirmQuietDeliveries({ afterHours: 48 });
  assert.equal((await eventsFor(s.prediction.id)).length, 0);
});

test('an unsubscribe does not block confirmation', async () => {
  // Unsubscribing proves the mailbox is real and the address correct. It
  // says we may not write again, not that we got it wrong.
  const s = await scenario();
  await suppress({ email: s.email, reason: 'unsubscribed', source: 'test' });

  await confirmQuietDeliveries({ afterHours: 48 });
  assert.equal((await eventsFor(s.prediction.id)).length, 1);
});
