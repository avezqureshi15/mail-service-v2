// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema, makeTestMailbox } from './helpers/test-db.js';
import { query, execute } from '../src/db/index.js';
import { runSequencerPass } from '../src/workers/sequencer.js';
import {
  createCampaign, replaceSteps, enrollContacts, getEnrollment, setCampaignStatus,
} from '../src/db/repositories/campaigns.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { suppress } from '../src/db/repositories/suppressions.js';

let mailbox;

before(async () => {
  await setupTestSchema();
  // Jobs are stamped with the mailbox that will send them, so a sequence
  // without one queues nothing at all.
  mailbox = await makeTestMailbox({ isDefault: true });
});
after(teardownTestSchema);

/** Builds an isolated 3-step sequence with one enrolled contact. */
async function makeSequence(emailLocalPart) {
  const email = `${emailLocalPart}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@seq.test`;
  const contact = await upsertContact({ email, firstName: 'Test', source: 'test' });

  const campaign = await createCampaign({
    name: `seq-${email}`,
    subject: 'Step one',
    htmlBody: '<p>Hello {{first_name}}</p>',
    isSequence: true,
    mailboxId: mailbox.id,
  });

  await replaceSteps(campaign.id, [
    { subject: 'Step one', htmlBody: '<p>First touch</p>', waitDays: 0 },
    { subject: 'Step two', htmlBody: '<p>Following up</p>', waitDays: 3 },
    { subject: 'Step three', htmlBody: '<p>Last note</p>', waitDays: 5 },
  ]);

  await enrollContacts(campaign.id, [contact.id]);
  await setCampaignStatus(campaign.id, 'sending');

  return { campaign, contact, email };
}

const queuedSteps = (campaignId, contactId) => query(
  `SELECT step_no, status FROM send_jobs
    WHERE campaign_id = $1 AND contact_id = $2 ORDER BY step_no`,
  [campaignId, contactId],
);

/** Makes the enrollment due again, as if the wait period had elapsed. */
const markDue = (campaignId, contactId, currentStep) => execute(
  `UPDATE sequence_enrollments
      SET current_step = $1, next_run_at = now() - interval '1 minute'
    WHERE campaign_id = $2 AND contact_id = $3`,
  [currentStep, campaignId, contactId],
);

test('sequencer queues step 1 for a fresh enrollment', async () => {
  const { campaign, contact } = await makeSequence('fresh');

  await runSequencerPass();

  const jobs = await queuedSteps(campaign.id, contact.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].step_no, 1);
  assert.equal(jobs[0].status, 'queued');

  // Parked until the sender reports step 1 as sent, so the same step is not
  // enqueued again on the next pass.
  await runSequencerPass();
  assert.equal((await queuedSteps(campaign.id, contact.id)).length, 1, 'step 1 must not be double-queued');
});

test('a reply stops the sequence - no follow-up is ever queued', async () => {
  const { campaign, contact } = await makeSequence('replied');

  await runSequencerPass();
  assert.equal((await queuedSteps(campaign.id, contact.id)).length, 1);

  // The contact answers step 1. The inbox poller records this.
  await execute(
    'INSERT INTO replies (contact_id, campaign_id, in_reply_to, email) VALUES ($1, $2, $3, $4)',
    [contact.id, campaign.id, '<step1@example.com>', 'x@seq.test'],
  );

  // Step 2 now falls due.
  await markDue(campaign.id, contact.id, 1);
  await runSequencerPass();

  const jobs = await queuedSteps(campaign.id, contact.id);
  assert.equal(jobs.length, 1, 'step 2 must not be queued after a reply');

  const enrollment = await getEnrollment(campaign.id, contact.id);
  assert.equal(enrollment.status, 'exited');
  assert.equal(enrollment.exit_reason, 'replied');
});

test('an unsubscribe stops the sequence', async () => {
  const { campaign, contact, email } = await makeSequence('unsub');

  await runSequencerPass();
  await suppress({ email, reason: 'unsubscribed', source: 'test' });

  await markDue(campaign.id, contact.id, 1);
  await runSequencerPass();

  assert.equal((await queuedSteps(campaign.id, contact.id)).length, 1, 'no follow-up after unsubscribe');
  const enrollment = await getEnrollment(campaign.id, contact.id);
  assert.equal(enrollment.status, 'exited');
  assert.equal(enrollment.exit_reason, 'unsubscribed');
});

test('a hard bounce stops the sequence', async () => {
  const { campaign, contact } = await makeSequence('bounced');

  await runSequencerPass();
  await execute("UPDATE contacts SET status = 'bounced' WHERE id = $1", [contact.id]);

  await markDue(campaign.id, contact.id, 1);
  await runSequencerPass();

  assert.equal((await queuedSteps(campaign.id, contact.id)).length, 1, 'no follow-up after a bounce');
  assert.equal((await getEnrollment(campaign.id, contact.id)).exit_reason, 'bounced');
});

test('an engaged contact progresses through every step, then completes', async () => {
  const { campaign, contact } = await makeSequence('progress');
  const steps = async () => (await queuedSteps(campaign.id, contact.id)).map((j) => j.step_no);

  await runSequencerPass();
  assert.deepEqual(await steps(), [1]);

  await markDue(campaign.id, contact.id, 1);
  await runSequencerPass();
  assert.deepEqual(await steps(), [1, 2]);

  await markDue(campaign.id, contact.id, 2);
  await runSequencerPass();
  assert.deepEqual(await steps(), [1, 2, 3]);

  // Nothing beyond the last step.
  await markDue(campaign.id, contact.id, 3);
  await runSequencerPass();
  assert.deepEqual(await steps(), [1, 2, 3]);
  assert.equal((await getEnrollment(campaign.id, contact.id)).status, 'completed');
});

test('sequences for a paused campaign do not advance', async () => {
  const { campaign, contact } = await makeSequence('paused');

  await runSequencerPass();
  await setCampaignStatus(campaign.id, 'paused');

  await markDue(campaign.id, contact.id, 1);
  await runSequencerPass();

  assert.equal((await queuedSteps(campaign.id, contact.id)).length, 1, 'a paused campaign must not queue more work');
});
