// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema, makeTestMailbox } from './helpers/test-db.js';
import { query, queryOne } from '../src/db/index.js';
import {
  loadMailboxes, getMailbox, activeMailboxes, sendingDomains, mailboxSecrets, pauseMailbox,
  createMailbox, updateMailbox, defaultMailbox,
} from '../src/db/repositories/mailboxes.js';
import { createCampaign, replaceSteps, setCampaignStatus, reassignMailbox } from '../src/db/repositories/campaigns.js';
import { queueJobs, claimNextJob, incrementSentToday, sentToday } from '../src/db/repositories/jobs.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { composeMessage } from '../src/mail/compose.js';
import { currentDailyAllowance } from '../src/lib/warmup.js';

/**
 * Two mailboxes sending side by side.
 *
 * This is the behaviour the whole feature turns on and the part the old
 * single-mailbox code could not express: jobs belong to the account that will
 * send them, counters do not bleed between accounts, and each message carries
 * the identity of its own mailbox rather than a process-wide default.
 */

let zoho;
let google;

before(async () => {
  await setupTestSchema();
  zoho = await makeTestMailbox({
    label: 'Zoho box', provider: 'zoho', smtpHost: 'smtp.zoho.com',
    fromEmail: 'zoho-sender@zoho.test', sendingDomain: 'zoho.test', isDefault: true,
  });
  google = await makeTestMailbox({
    label: 'Google box', provider: 'google', smtpHost: 'smtp.gmail.com',
    fromEmail: 'g-sender@google.test', sendingDomain: 'google.test',
  });
});
after(teardownTestSchema);

async function makeCampaign(mailboxId, name) {
  const campaign = await createCampaign({
    name: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    subject: 'Hello',
    htmlBody: '<p>Hi {{first_name}}</p>',
    mailboxId,
  });
  await replaceSteps(campaign.id, [{ subject: 'Hello', htmlBody: '<p>Hi</p>', waitDays: 0 }]);
  await setCampaignStatus(campaign.id, 'sending');
  return campaign;
}

const contactFor = (tag) => upsertContact({
  email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@recipient.test`,
  firstName: 'Test',
  source: 'test',
});

test('effective pacing follows the provider preset until it is overridden', async () => {
  await loadMailboxes();

  // Zoho's recommended cap is far below Google's; a NULL column must track
  // the preset rather than a number copied at creation.
  const z = getMailbox(zoho.id);
  const g = getMailbox(google.id);

  assert.equal(z.pacing.dailyCap, 300, 'zoho follows its own preset');
  assert.equal(g.pacing.dailyCap, 1200, 'google follows its own preset');
  assert.ok(g.pacing.dailyCap > z.pacing.dailyCap,
    'a shared global cap would have flattened these to one number');
});

test('an explicit cap overrides the preset', async () => {
  const custom = await makeTestMailbox({ provider: 'google' });
  const { updateMailbox } = await import('../src/db/repositories/mailboxes.js');
  const updated = await updateMailbox(custom.id, { daily_cap: 42 });
  assert.equal(updated.pacing.dailyCap, 42);
});

test('a stored password decrypts back to what was sealed', async () => {
  const { smtpPassword } = await mailboxSecrets(zoho.id);
  assert.equal(smtpPassword, 'test-password');

  // And the column really is ciphertext, not the password.
  const row = await queryOne('SELECT smtp_password_cipher FROM mailboxes WHERE id = $1', [zoho.id]);
  assert.ok(row.smtp_password_cipher.startsWith('v1.'));
  assert.ok(!row.smtp_password_cipher.includes('test-password'));
});

test('each message carries its own mailbox identity, not a global one', async () => {
  await loadMailboxes();
  const campaign = { id: 1, subject: 'S', html_body: '<p>Body</p>', from_name: '', from_email: '', reply_to: '', preheader: '', tracking_enabled: false };
  const step = { subject: '', html_body: '', preheader: '' };
  const contact = { id: null, email: 'x@recipient.test', first_name: 'X', last_name: '', company: '', custom_fields: '{}' };

  const fromZoho = composeMessage({ campaign, step, contact, mailbox: getMailbox(zoho.id) });
  const fromGoogle = composeMessage({ campaign, step, contact, mailbox: getMailbox(google.id) });

  assert.equal(fromZoho.message.from.address, 'zoho-sender@zoho.test');
  assert.equal(fromGoogle.message.from.address, 'g-sender@google.test');

  // The Message-ID follows the mailbox's own sending domain, which is what
  // the inbox poller matches on to recognise our own mail.
  assert.ok(fromZoho.messageId.endsWith('@zoho.test>'), fromZoho.messageId);
  assert.ok(fromGoogle.messageId.endsWith('@google.test>'), fromGoogle.messageId);
});

test('composing without a mailbox throws rather than silently defaulting', () => {
  assert.throws(
    () => composeMessage({
      campaign: { id: 1, subject: 'S', html_body: '<p>x</p>' },
      step: { subject: '', html_body: '' },
      contact: { id: null, email: 'a@b.test', first_name: '', last_name: '', company: '', custom_fields: '{}' },
    }),
    /requires the campaign/,
  );
});

test('queued jobs are stamped with the mailbox that will send them', async () => {
  const zCampaign = await makeCampaign(zoho.id, 'zoho-campaign');
  const gCampaign = await makeCampaign(google.id, 'google-campaign');

  await queueJobs(zCampaign.id, [await contactFor('z')], 1, 1, zoho.id);
  await queueJobs(gCampaign.id, [await contactFor('g')], 1, 1, google.id);

  const [zJob] = await query('SELECT mailbox_id FROM send_jobs WHERE campaign_id = $1', [zCampaign.id]);
  const [gJob] = await query('SELECT mailbox_id FROM send_jobs WHERE campaign_id = $1', [gCampaign.id]);

  assert.equal(zJob.mailbox_id, zoho.id);
  assert.equal(gJob.mailbox_id, google.id);
});

test('queueing without a mailbox is refused rather than producing an unclaimable job', async () => {
  const campaign = await makeCampaign(zoho.id, 'unstamped');
  const contact = await contactFor('u');
  await assert.rejects(
    () => queueJobs(campaign.id, [contact], 1, 1, null),
    /requires the campaign/,
  );
});

test('an unstamped job is claimed by nobody rather than sent by whoever picks it up', async () => {
  const campaign = await makeCampaign(zoho.id, 'orphan');
  const contact = await contactFor('orphan');
  await queueJobs(campaign.id, [contact], 1, 1, zoho.id);
  // Simulate the backfill gap: a row that predates the mailbox column.
  await query('UPDATE send_jobs SET mailbox_id = NULL WHERE campaign_id = $1', [campaign.id]);

  let claimed = null;
  for (let i = 0; i < 5; i += 1) {
    const job = await claimNextJob([]);
    if (!job) break;
    if (job.campaign_id === campaign.id) { claimed = job; break; }
  }
  assert.equal(claimed, null, 'a job with no mailbox must never be claimed');
});

test('daily counters are independent per mailbox', async () => {
  await incrementSentToday(zoho.id);
  await incrementSentToday(zoho.id);
  await incrementSentToday(google.id);

  assert.equal(await sentToday(zoho.id), 2);
  assert.equal(await sentToday(google.id), 1, 'one mailbox must not spend another mailbox allowance');
});

test('reassigning a campaign takes its queued jobs with it', async () => {
  const campaign = await makeCampaign(zoho.id, 'moving');
  await queueJobs(campaign.id, [await contactFor('move')], 1, 1, zoho.id);

  await reassignMailbox(campaign.id, google.id);

  const rows = await query('SELECT mailbox_id FROM send_jobs WHERE campaign_id = $1', [campaign.id]);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.mailbox_id, google.id,
      'queued work left behind would keep sending from the old account');
  }
});

test('a paused mailbox drops out of the active set without affecting the others', async () => {
  await pauseMailbox(google.id, { minutes: 60, reason: 'provider quota' });

  const active = activeMailboxes().map((m) => m.id);
  assert.ok(!active.includes(google.id), 'a quota-paused mailbox must stop being scheduled');
  assert.ok(active.includes(zoho.id), 'pausing one mailbox must not stop the rest');

  // And it heals itself: clearing the timestamp brings it straight back.
  const { updateMailbox } = await import('../src/db/repositories/mailboxes.js');
  await updateMailbox(google.id, { paused_until: null, pause_reason: null });
  assert.ok(activeMailboxes().map((m) => m.id).includes(google.id));
});

test('sending domains are collected for the inbox poller pre-filter', async () => {
  await loadMailboxes();
  const domains = sendingDomains();
  assert.ok(domains.includes('zoho.test'));
  assert.ok(domains.includes('google.test'));
});

test('warm-up ramps each mailbox on its own schedule', () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const ramping = currentDailyAllowance({
    dailyCap: 1200,
    warmupEnabled: true,
    warmupStartedOn: yesterday,
    warmupSchedule: [20, 27, 36],
  });
  assert.equal(ramping, 27, 'day two of the ramp, not the full cap');

  const finished = currentDailyAllowance({
    dailyCap: 1200,
    warmupEnabled: true,
    warmupStartedOn: '2020-01-01',
    warmupSchedule: [20, 27, 36],
  });
  assert.equal(finished, 1200, 'past the end of the ramp the cap applies');

  const notStarted = currentDailyAllowance({
    dailyCap: 300, warmupEnabled: true, warmupStartedOn: null, warmupSchedule: [20],
  });
  assert.equal(notStarted, 300);
});


test('adding a second mailbox as the default demotes the first instead of failing', async () => {
  // Only one mailbox per tenant may be the default, enforced by a partial
  // unique index. Clearing the incumbent has to happen before the new row
  // lands - doing it afterwards means the insert is already rejected, and the
  // operator sees a duplicate-name error for a name that is not duplicated.
  const { seal } = await import('../src/lib/secret-box.js');
  const suffix = Math.random().toString(36).slice(2, 8);

  const before = defaultMailbox();
  assert.ok(before, 'this test needs an existing default to displace');

  const created = await createMailbox({
    label: `promoted-${suffix}`,
    provider: 'zoho',
    from_name: 'New Default',
    from_email: `new-default-${suffix}@promote.test`,
    sending_domain: 'promote.test',
    dkim_selector: 'zoho',
    smtp_host: 'smtppro.zoho.in',
    smtp_port: 465,
    smtp_user: `new-default-${suffix}@promote.test`,
    smtp_password_cipher: seal('pw'),
    imap_enabled: false,
    is_active: true,
    is_default: true,
  });

  assert.equal(created.is_default, true, 'the new mailbox should be the default');
  assert.equal(getMailbox(before.id).is_default, false, 'the previous default should have been demoted');
  assert.equal(defaultMailbox().id, created.id);
});

test('promoting an existing mailbox to default also demotes the incumbent', async () => {
  const incumbent = defaultMailbox();
  const other = activeMailboxes().find((m) => m.id !== incumbent.id);
  assert.ok(other, 'needs a second mailbox');

  const updated = await updateMailbox(other.id, { is_default: true });

  assert.equal(updated.is_default, true);
  assert.equal(getMailbox(incumbent.id).is_default, false);
});
