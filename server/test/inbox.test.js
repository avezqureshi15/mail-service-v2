// Must come first: points the app at a scratch schema before env.js reads
// the configuration.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import { queryOne, execute } from '../src/db/index.js';
import {
  handleReply, handleBounce, handleUnsubscribeRequest,
  isDeliveryReport, isComplaint, classifyBounce,
} from '../src/workers/inbox-poller.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { isSuppressed } from '../src/db/repositories/suppressions.js';
import { getSettings } from '../src/db/repositories/settings.js';
import { env } from '../src/config/env.js';

before(setupTestSchema);
after(teardownTestSchema);

/**
 * Bounce and reply detection, driven by raw messages rather than a live
 * mailbox - so the matching logic is verified without needing IMAP, a
 * network, or someone to reply by hand.
 */

/** A sent campaign message for inbound mail to be matched against. */
async function seedSend(email) {
  const contact = await upsertContact({ email, source: 'test' });
  const { id: campaignId } = await queryOne(
    "INSERT INTO campaigns (name, subject, status) VALUES ('t', 's', 'sending') RETURNING id",
  );
  const messageId = `<test.${Date.now()}.${Math.random().toString(36).slice(2)}@${env.SENDING_DOMAIN}>`;

  await execute(
    `INSERT INTO send_jobs (campaign_id, contact_id, step_no, recipient_domain, status, message_id, sent_at)
     VALUES ($1, $2, 1, $3, 'sent', $4, now())`,
    [campaignId, contact.id, email.split('@')[1], messageId],
  );

  return { contact, campaignId, messageId };
}

const countReplies = async (contactId, campaignId = null) => (await queryOne(
  `SELECT COUNT(*) AS n FROM replies
    WHERE contact_id = $1 AND ($2::int IS NULL OR campaign_id = $2::int)`,
  [contactId, campaignId],
)).n;

test('a reply is matched to the send it answers', async () => {
  const { contact, campaignId, messageId } = await seedSend('prospect@reply.test');

  const raw = [
    'From: Dana Prospect <prospect@reply.test>',
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: Re: Quick question',
    `In-Reply-To: ${messageId}`,
    `References: ${messageId}`,
    '',
    'Sounds interesting, send me more detail.',
  ].join('\r\n');

  const parsed = await simpleParser(raw);

  assert.equal(isDeliveryReport(parsed), false, 'a human reply is not a delivery report');
  assert.equal(await handleReply({ parsed }), true, 'the reply should be matched');

  const row = await queryOne('SELECT * FROM replies WHERE contact_id = $1', [contact.id]);
  assert.ok(row, 'the reply must be recorded');
  assert.equal(row.campaign_id, campaignId, 'attributed to the right campaign');
});

test('a reply halts that contact’s active sequences', async () => {
  const { contact, campaignId, messageId } = await seedSend('engaged@reply.test');

  await execute(
    `INSERT INTO sequence_enrollments (campaign_id, contact_id, current_step, next_run_at, status)
     VALUES ($1, $2, 1, now(), 'active')`,
    [campaignId, contact.id],
  );

  const parsed = await simpleParser([
    'From: engaged@reply.test',
    'Subject: Re: hello',
    `In-Reply-To: ${messageId}`,
    '',
    'yes please',
  ].join('\r\n'));

  await handleReply({ parsed });

  const enrollment = await queryOne(
    'SELECT status, exit_reason FROM sequence_enrollments WHERE contact_id = $1',
    [contact.id],
  );
  assert.equal(enrollment.status, 'exited');
  assert.equal(enrollment.exit_reason, 'replied', 'nobody should be chased after answering');
});

test('unrelated mail in the inbox is not treated as a reply', async () => {
  const total = async () => (await queryOne('SELECT COUNT(*) AS n FROM replies')).n;
  const before_ = await total();

  const parsed = await simpleParser([
    'From: newsletter@somewhere.test',
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: Your weekly digest',
    'In-Reply-To: <unrelated-thread@somewhere.test>',
    '',
    'This has nothing to do with us.',
  ].join('\r\n'));

  assert.equal(await handleReply({ parsed }), false);
  assert.equal(await total(), before_,
    'a real inbox is full of mail that is not a reply to us');
});

test('a hard bounce suppresses the address', async () => {
  const email = 'nosuchuser@bounce.test';
  const { messageId } = await seedSend(email);

  const raw = [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: Delivery Status Notification (Failure)',
    'Content-Type: text/plain',
    '',
    'Your message was not delivered.',
    '',
    `Final-Recipient: rfc822; ${email}`,
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
    `References: ${messageId}`,
  ].join('\r\n');

  const parsed = await simpleParser(raw);

  assert.equal(isDeliveryReport(parsed), true);
  assert.equal(await handleBounce({ parsed, settings: getSettings() }), true);

  assert.equal(await isSuppressed(email), true, 'a hard bounce must never be mailed again');
  assert.equal(
    (await queryOne('SELECT status FROM contacts WHERE email = $1', [email])).status,
    'bounced',
  );
});

test('the same bounce arriving twice is counted once', async () => {
  const email = 'duplicate@bounce.test';
  const { messageId } = await seedSend(email);

  const raw = [
    'From: mailer-daemon@googlemail.com',
    'Subject: Undeliverable',
    'Content-Type: text/plain',
    '',
    `Final-Recipient: rfc822; ${email}`,
    'Status: 5.1.1',
    `References: ${messageId}`,
  ].join('\r\n');

  const parsed = await simpleParser(raw);
  await handleBounce({ parsed, settings: getSettings() });
  await handleBounce({ parsed, settings: getSettings() });

  const { n } = await queryOne('SELECT COUNT(*) AS n FROM bounces WHERE email = $1', [email]);
  // Double-counting inflates the 24h bounce rate that auto-pauses sending.
  assert.equal(n, 1, 'a re-read message must not count twice');
});

test('soft bounces are distinguished from hard ones', () => {
  assert.equal(classifyBounce({ dsnStatus: '5.1.1' }).type, 'hard');
  assert.equal(classifyBounce({ dsnStatus: '4.2.2' }).type, 'soft');
  assert.equal(classifyBounce({ smtpCode: '550' }).type, 'hard');
  assert.equal(classifyBounce({ smtpCode: '452' }).type, 'soft');
  assert.equal(classifyBounce({ text: 'mailbox is full, over quota' }).type, 'soft');
  assert.equal(classifyBounce({ text: 'no such user here' }).type, 'hard');
  // An out-of-office is not a failure and must not suppress anyone. It used
  // to be filed as a soft bounce, which counted towards the soft-bounce
  // limit and could eventually suppress someone who had gone on holiday.
  assert.equal(classifyBounce({ text: 'I am out of office until Monday' }).type, 'auto_reply');
});

test('a feedback-loop complaint is recognised', async () => {
  const parsed = await simpleParser([
    'From: feedback@hotmail.com',
    'Subject: Email abuse report for IP 1.2.3.4',
    '',
    'This is an email abuse report.',
  ].join('\r\n'));

  assert.equal(isComplaint(parsed), true);
});

test('ten replies from the same person count as one', async () => {
  const { contact, campaignId, messageId } = await seedSend('chatty@reply.test');

  for (let i = 1; i <= 10; i += 1) {
    const parsed = await simpleParser([
      'From: chatty@reply.test',
      `Subject: Re: thread (message ${i})`,
      `In-Reply-To: ${messageId}`,
      '',
      `Follow-up number ${i}`,
    ].join('\r\n'));
    await handleReply({ parsed });
  }

  // The metric is "did this person reply", not "how many emails did they
  // send". Counting each message would let one talkative prospect push the
  // reply rate above 100%.
  assert.equal(await countReplies(contact.id, campaignId), 1,
    'a person who replies ten times has still replied once');
});

test('different people replying are counted separately', async () => {
  const a = await seedSend('first@reply.test');
  const b = await seedSend('second@reply.test');

  for (const { messageId } of [a, b]) {
    const parsed = await simpleParser([
      'Subject: Re: hello',
      `In-Reply-To: ${messageId}`,
      '',
      'interested',
    ].join('\r\n'));
    await handleReply({ parsed });
  }

  assert.equal(await countReplies(a.contact.id), 1);
  assert.equal(await countReplies(b.contact.id), 1);
});

test('the same person replying to two campaigns counts once per campaign', async () => {
  const email = 'multi@reply.test';
  const one = await seedSend(email);
  const two = await seedSend(email);
  assert.equal(one.contact.id, two.contact.id, 'same contact, two campaigns');

  for (const { messageId } of [one, two]) {
    const parsed = await simpleParser([
      'Subject: Re: hello',
      `In-Reply-To: ${messageId}`,
      '',
      'yes',
    ].join('\r\n'));
    await handleReply({ parsed });
  }

  assert.equal(await countReplies(one.contact.id), 2,
    'replying to a second campaign is a separate signal');
});

test('a mailto unsubscribe is honoured', async () => {
  // Every message advertises a mailto: opt-out in List-Unsubscribe. Clients
  // that do not do one-click use it, and it arrives as ordinary email.
  const email = 'optout@reply.test';
  await upsertContact({ email, source: 'test' });

  const parsed = await simpleParser([
    `From: ${email}`,
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: unsubscribe',
    '',
    '',
  ].join('\r\n'));

  assert.equal(await handleUnsubscribeRequest({ parsed }), true);
  assert.equal(await isSuppressed(email), true, 'an advertised opt-out must actually work');
  assert.equal(
    (await queryOne('SELECT method FROM unsubscribes WHERE email = $1', [email])).method,
    'mailto',
  );
});

test('a mailto unsubscribe exits active sequences', async () => {
  const email = 'optout-seq@reply.test';
  const { contact, campaignId } = await seedSend(email);
  await execute(
    `INSERT INTO sequence_enrollments (campaign_id, contact_id, current_step, next_run_at, status)
     VALUES ($1, $2, 1, now(), 'active')`,
    [campaignId, contact.id],
  );

  const parsed = await simpleParser([
    `From: ${email}`, 'Subject: Re: unsubscribe', '', '',
  ].join('\r\n'));
  await handleUnsubscribeRequest({ parsed });

  assert.equal(
    (await queryOne(
      'SELECT exit_reason FROM sequence_enrollments WHERE contact_id = $1',
      [contact.id],
    )).exit_reason,
    'unsubscribed',
  );
});

test('an opt-out subject from a stranger is ignored', async () => {
  // Otherwise a newsletter whose subject starts "Unsubscribe..." would add
  // somebody who is not our contact to the suppression list.
  const email = 'not-our-contact@elsewhere.test';
  const parsed = await simpleParser([
    `From: ${email}`, 'Subject: Unsubscribe from our mailing list', '', '',
  ].join('\r\n'));

  assert.equal(await handleUnsubscribeRequest({ parsed }), false);
  assert.equal(await isSuppressed(email), false);
});

test('ordinary mail is not mistaken for an opt-out', async () => {
  const email = 'warm@reply.test';
  await upsertContact({ email, source: 'test' });

  for (const subject of ['Stopping by next week', 'Re: pricing', 'Please stop sending']) {
    const parsed = await simpleParser([`From: ${email}`, `Subject: ${subject}`, '', ''].join('\r\n'));
    assert.equal(await handleUnsubscribeRequest({ parsed }), false, `"${subject}" must not unsubscribe anyone`);
  }
  assert.equal(await isSuppressed(email), false, 'a warm lead must not be suppressed by a turn of phrase');
});
