// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema, makeTestMailbox } from './helpers/test-db.js';
import { query, execute } from '../src/db/index.js';
import { createCampaign, replaceSteps, setCampaignStatus } from '../src/db/repositories/campaigns.js';
import { queueJobs, claimNextJob } from '../src/db/repositories/jobs.js';
import { upsertContact } from '../src/db/repositories/contacts.js';

/**
 * The claim, which is the one piece of the sender that two loops touch at the
 * same time.
 *
 * Nothing exercised this before - the old sender was a single global loop, so
 * there was no concurrency to get wrong. Now one loop runs per mailbox and
 * three properties have to hold: a loop sees only its own mailbox's work,
 * two loops can never take the same row, and a job belonging to no mailbox is
 * taken by nobody rather than sent by whoever happens to find it.
 */

let alpha;
let beta;

before(async () => {
  await setupTestSchema();
  alpha = await makeTestMailbox({ label: 'alpha-box', fromEmail: 'alpha@claim.test' });
  beta = await makeTestMailbox({ label: 'beta-box', fromEmail: 'beta@claim.test' });
});
after(teardownTestSchema);

async function queueFor(mailboxId, tag, count = 1) {
  const campaign = await createCampaign({
    name: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    subject: 'S',
    htmlBody: '<p>Body</p>',
    mailboxId,
  });
  await replaceSteps(campaign.id, [{ subject: 'S', htmlBody: '<p>Body</p>', waitDays: 0 }]);
  await setCampaignStatus(campaign.id, 'sending');

  const contacts = [];
  for (let i = 0; i < count; i += 1) {
    contacts.push(await upsertContact({
      email: `${tag}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@claim.test`,
      firstName: 'C',
      source: 'test',
    }));
  }

  await queueJobs(campaign.id, contacts, 1, 1, mailboxId);
  return campaign;
}

/** Puts claimed rows back, so one test does not drain the queue for the next. */
function release(campaignId) {
  return execute(
    "UPDATE send_jobs SET status = 'queued', locked_at = NULL WHERE campaign_id = $1",
    [campaignId],
  );
}

test('a loop claims only its own mailbox’s work', async () => {
  const alphaCampaign = await queueFor(alpha.id, 'alpha-only', 2);
  const betaCampaign = await queueFor(beta.id, 'beta-only', 2);

  const claimedByAlpha = [];
  for (let i = 0; i < 4; i += 1) {
    const job = await claimNextJob([], alpha.id);
    if (!job) break;
    if (!job.skipped) claimedByAlpha.push(job);
  }

  assert.ok(claimedByAlpha.length > 0, 'alpha should have found its own work');
  for (const job of claimedByAlpha) {
    assert.equal(job.mailbox_id, alpha.id,
      'a loop must never pick up another mailbox’s job');
  }

  await release(alphaCampaign.id);
  await release(betaCampaign.id);
});

test('two concurrent claims never return the same job', async () => {
  const campaign = await queueFor(alpha.id, 'race', 6);

  // Fired together rather than in sequence: this is the case SKIP LOCKED
  // exists for, and getting it wrong means mailing one person twice.
  const results = await Promise.all([
    claimNextJob([], alpha.id),
    claimNextJob([], alpha.id),
    claimNextJob([], alpha.id),
    claimNextJob([], alpha.id),
  ]);

  const ids = results.filter((j) => j && !j.skipped).map((j) => j.id);
  assert.ok(ids.length >= 2, 'expected several claims to succeed');
  assert.equal(new Set(ids).size, ids.length, 'the same job was claimed twice');

  await release(campaign.id);
});

test('a job stamped for another mailbox is invisible, not merely skipped', async () => {
  const campaign = await queueFor(beta.id, 'other-mailbox', 1);

  const job = await claimNextJob([], alpha.id);
  if (job && !job.skipped) {
    assert.notEqual(job.campaign_id, campaign.id,
      'alpha claimed a job queued for beta');
  }

  // And the row is untouched - not locked, not skipped, still waiting for
  // its own loop.
  const [row] = await query(
    'SELECT status FROM send_jobs WHERE campaign_id = $1',
    [campaign.id],
  );
  assert.equal(row.status, 'queued');

  await release(campaign.id);
});

test('a blocked receiving domain is skipped for every mailbox', async () => {
  // The per-domain burst cap is global on purpose: a receiver attributes
  // traffic from all our mailboxes on one sending domain to one sender, so
  // each mailbox measuring its own allowance would multiply the burst.
  const campaign = await queueFor(alpha.id, 'blocked-domain', 1);
  const [row] = await query(
    'SELECT recipient_domain FROM send_jobs WHERE campaign_id = $1',
    [campaign.id],
  );

  const job = await claimNextJob([row.recipient_domain], alpha.id);
  if (job && !job.skipped) {
    assert.notEqual(job.campaign_id, campaign.id,
      'a job for a throttled receiving domain must not be claimed');
  }

  await release(campaign.id);
});
