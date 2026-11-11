// Must come first: points the app at a scratch schema.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';

import { setupTestSchema, teardownTestSchema, makeTestMailbox } from './helpers/test-db.js';
import { env } from '../src/config/env.js';
import { query, queryOne, execute } from '../src/db/index.js';
import { upsertContact } from '../src/db/repositories/contacts.js';
import { getSettings } from '../src/db/repositories/settings.js';
import {
  knowledgeForDomains, recordPattern, savePredictions, patternsForDomain,
} from '../src/db/repositories/predictions.js';
import { predictRows, dedupeByEmail, splitSuppressed } from '../src/lib/predictor.js';
import { suppress, suppressedSubset } from '../src/db/repositories/suppressions.js';
import { rolloutStateFor, gateResults } from '../src/lib/rollout.js';
import { confirmQuietDeliveries } from '../src/workers/delivery-confirmer.js';
import { handleBounce, handleReply } from '../src/workers/inbox-poller.js';

let watchedMailbox;

before(async () => {
  await setupTestSchema();
  // Confirmation is only valid for a mailbox that actually watches its
  // inbox - silence from one with IMAP off proves nothing.
  // The sending domain has to match the Message-IDs this file builds, or the
  // poller's pre-filter discards them before the job lookup ever runs.
  watchedMailbox = await makeTestMailbox({
    imapEnabled: true,
    isDefault: true,
    sendingDomain: env.SENDING_DOMAIN,
  });
});
after(teardownTestSchema);

/**
 * The whole loop, end to end, against a real database.
 *
 * Everything below the SMTP socket is exercised with the functions the
 * route and the workers actually call - `knowledgeForDomains` lives in the
 * repository precisely so this file is not testing a copy of the route's
 * logic. What is still not covered is the transport: a real message leaving
 * Zoho, and a real DSN being fetched over IMAP. The bounces here are built
 * as RFC-shaped messages and handed to the same `handleBounce` the poller
 * calls, so everything after `simpleParser` is the production path.
 */

let seq = 0;
const nextDomain = () => { seq += 1; return `co${seq}-${process.pid}.test`; };

/** A company whose format one seed has asserted and nothing has confirmed. */
async function seedCompany(domain, pattern = 'first.last') {
  await recordPattern({
    domain, pattern, provenance: 'asserted', learnedFrom: `seed@${domain}`,
  });
  return domain;
}

/** The route's pipeline: load what we know, predict, gate, record. */
async function runPredict(domain, names, { probeBudget = 1 } = {}) {
  const knowledge = await knowledgeForDomains([domain]);
  const state = rolloutStateFor(knowledge.get(domain)?.rows ?? []);

  const { results } = predictRows(names.map((name) => ({ name, domain })), knowledge);
  const unique = dedupeByEmail(results);

  // Before gating, exactly as the route does - a suppressed row must not
  // consume the probe slot.
  const suppressed = await suppressedSubset(unique.map((r) => r.email));
  const { mailable, blocked } = splitSuppressed(unique, suppressed);

  const gated = gateResults({ results: mailable, state, probeBudget, domain });
  gated.blocked = blocked;

  if (gated.revealed.length > 0) {
    await savePredictions(gated.revealed.map((r) => ({
      domain: r.domain,
      input_name: r.inputName,
      first_name: r.firstName,
      last_name: r.lastName,
      predicted_email: r.email,
      pattern: r.pattern,
      confidence: r.score,
      band: r.band,
      name_confidence: r.nameConfidence,
      name_source: r.nameSource,
      reading_count: r.readingCount,
    })));
  }
  return { ...gated, state };
}

/** Mails the address, far enough in the past for the sweep to consider it. */
async function sendTo(email, hoursAgo = 72) {
  const contact = await upsertContact({ email, source: 'test' });
  const { id: campaignId } = await queryOne(
    "INSERT INTO campaigns (name, subject, status) VALUES ('t', 's', 'sending') RETURNING id",
  );
  const messageId = `<lc.${seq}.${Math.random().toString(36).slice(2)}@${env.SENDING_DOMAIN}>`;

  await execute(
    `INSERT INTO send_jobs (campaign_id, contact_id, step_no, recipient_domain, status, message_id, sent_at, mailbox_id)
     VALUES ($1, $2, 1, $3, 'sent', $4, now() - make_interval(hours => $5), $6)`,
    [campaignId, contact.id, email.split('@')[1], messageId, hoursAgo, watchedMailbox.id],
  );
  return { contact, campaignId, messageId };
}

/** A real DSN, through the real handler. */
async function bounce(email, messageId, status, diagnostic) {
  const parsed = await simpleParser([
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: Delivery Status Notification (Failure)',
    'Content-Type: text/plain',
    '',
    'Your message was not delivered.',
    '',
    `Final-Recipient: rfc822; ${email}`,
    'Action: failed',
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
    `References: ${messageId}`,
  ].join('\r\n'));

  return handleBounce({ parsed, settings: getSettings() });
}

async function replyFrom(email, messageId) {
  const parsed = await simpleParser([
    `From: ${email}`,
    `To: ${env.MAIL_FROM_ADDRESS}`,
    'Subject: Re: hello',
    `In-Reply-To: ${messageId}`,
    '',
    'sure, send over a time',
  ].join('\r\n'));

  return handleReply({ parsed });
}

const patternRow = async (domain, pattern = 'first.last') =>
  (await patternsForDomain(domain)).find((r) => r.pattern === pattern);

const stateOf = async (domain) => {
  const knowledge = await knowledgeForDomains([domain]);
  return rolloutStateFor(knowledge.get(domain)?.rows ?? []);
};

const PEOPLE = ['Alice Stone', 'Brian Cole', 'Carla Diaz', 'Dan Fisher'];

// ------------------------------------------------------- the happy path

test('a company goes probing -> validated on a quiet send, and then opens up', async () => {
  const domain = await seedCompany(nextDomain());

  // One seed, nothing confirmed: one person out, alternatives withheld.
  const first = await runPredict(domain, PEOPLE);
  assert.equal(first.rollout.state, 'probing');
  assert.equal(first.revealed.length, 1);
  assert.equal(first.rollout.heldPeople, 3);
  assert.deepEqual(first.revealed[0].alternatives, []);

  // Asking again with no new feedback must not unlock anything - a click
  // is not evidence.
  const again = await runPredict(domain, PEOPLE);
  assert.equal(again.revealed.length, 1);
  assert.equal(again.rollout.state, 'probing');

  // Mail the probe, and let it stay quiet.
  await sendTo(first.revealed[0].email);
  const { confirmed } = await confirmQuietDeliveries({ afterHours: 48 });
  assert.ok(confirmed >= 1);

  assert.equal(await stateOf(domain), 'validated');

  // Now the whole company is available, alternatives included.
  const opened = await runPredict(domain, PEOPLE);
  assert.equal(opened.rollout.state, 'validated');
  assert.equal(opened.revealed.length, 4);
  assert.equal(opened.rollout.probe, false);
});

test('a reply proves the format, where a quiet send only confirms it', async () => {
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, PEOPLE);

  const { messageId } = await sendTo(revealed[0].email);
  assert.equal(await replyFrom(revealed[0].email, messageId), true);

  const row = await patternRow(domain);
  assert.equal(row.provenance, 'proven', 'a human read it - that is proof');
  assert.equal(await stateOf(domain), 'validated');
});

test('a suppressed person does not consume the probe', async () => {
  // The bug: the suppressed row took the single probe slot and was then
  // hidden by the page, so the operator saw an empty result, the company
  // stayed locked, and there was nothing to act on.
  const domain = await seedCompany(nextDomain());
  const first = `alice.stone@${domain}`;
  await suppress({ email: first, reason: 'unsubscribed', source: 'test' });

  const out = await runPredict(domain, PEOPLE);

  assert.equal(out.revealed.length, 1, 'a mailable person must still come through');
  assert.notEqual(out.revealed[0].email, first);
  assert.deepEqual(out.blocked.map((b) => b.email), [first]);
  assert.equal(out.blocked[0].reason, 'suppressed');
});

// ----------------------------------------------------- the failure path

test('a wrong-address bounce disputes the company, and a second retires the format', async () => {
  const domain = await seedCompany(nextDomain());

  const first = await runPredict(domain, PEOPLE);
  const a = first.revealed[0];
  const sendA = await sendTo(a.email);
  assert.equal(await bounce(a.email, sendA.messageId, '5.1.1', '550 5.1.1 user unknown'), true);

  assert.equal((await patternRow(domain)).rejected_count, 1);
  assert.equal(await stateOf(domain), 'disputed', 'something bounced and nothing has landed');

  // Still gated, so the next person is the next probe rather than a batch.
  const second = await runPredict(domain, PEOPLE.slice(1));
  assert.equal(second.revealed.length, 1);
  const b = second.revealed[0];

  const sendB = await sendTo(b.email);
  await bounce(b.email, sendB.messageId, '5.1.1', '550 5.1.1 no such user');

  assert.equal((await patternRow(domain)).rejected_count, 2);
  // Twice wrong with nothing to its credit: the format is retired, and the
  // company reads as unknown again rather than offering a dead guess.
  assert.equal(await stateOf(domain), 'unknown');

  const after = await runPredict(domain, PEOPLE);
  assert.equal(after.revealed.length, 0);
});

test('a policy block changes nothing about the format', async () => {
  // The bug this guards: every 5.x.x used to count, so a spam filter could
  // retire a perfectly good format.
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, PEOPLE);

  const { messageId } = await sendTo(revealed[0].email);
  await bounce(revealed[0].email, messageId, '5.7.1', '550 5.7.1 message blocked');

  assert.equal((await patternRow(domain)).rejected_count, 0);
  assert.equal(await stateOf(domain), 'probing', 'still unconfirmed, but not disputed');
});

test('a full mailbox proves the address exists and must not demote it', async () => {
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, PEOPLE);

  const { messageId } = await sendTo(revealed[0].email);
  await bounce(revealed[0].email, messageId, '5.2.2', '552 5.2.2 mailbox full');

  assert.equal((await patternRow(domain)).rejected_count, 0);
});

// ----------------------------------------------------- what we recorded

test('how the name was read is stored with the prediction', async () => {
  // Without this, a bounce on qureshi@ can never be told apart later:
  // wrong format, or wrong word picked as the surname? The two call for
  // opposite corrections and the evidence cannot be reconstructed.
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, ['Alice Stone']);

  const row = await queryOne(
    'SELECT name_confidence, name_source, reading_count FROM email_predictions WHERE lower(predicted_email) = $1',
    [revealed[0].email],
  );
  assert.equal(row.name_confidence, 'clean');
  assert.equal(row.name_source, 'rules');
  assert.equal(row.reading_count, 1);
});

test('an uncertain reading is recorded as uncertain', async () => {
  // "Sharma, Rajesh" reverses on the comma, which the parser flags because
  // the guess could legitimately go either way.
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, ['Sharma, Rajesh']);

  const row = await queryOne(
    'SELECT name_confidence FROM email_predictions WHERE lower(predicted_email) = $1',
    [revealed[0].email],
  );
  assert.equal(row.name_confidence, 'ambiguous');
});

test('a contested reading records how many answers were plausible', async () => {
  // A bracketed nickname produces two real candidates, and that count is
  // what drove the band - so it is what a later analysis needs.
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, ['Mike (Michael) Chen']);

  const row = await queryOne(
    'SELECT reading_count FROM email_predictions WHERE lower(predicted_email) = $1',
    [revealed[0].email],
  );
  assert.equal(row.reading_count, 2);
});

// ------------------------------------------------------------ ordering

test('a bounce arriving after a delivery is still recorded and still wins', async () => {
  // The write-once bug: `outcome` was set on the first result and
  // `predictionForEmail` then filtered on it being NULL, so a later bounce
  // was dropped entirely.
  const domain = await seedCompany(nextDomain());
  const { revealed } = await runPredict(domain, PEOPLE);
  const email = revealed[0].email;

  const { messageId } = await sendTo(email);
  await confirmQuietDeliveries({ afterHours: 48 });

  const prediction = await queryOne(
    'SELECT * FROM email_predictions WHERE lower(predicted_email) = $1', [email],
  );
  assert.equal(prediction.outcome, 'delivered');

  await bounce(email, messageId, '5.1.1', '550 5.1.1 user unknown');

  const events = await query(
    'SELECT event_type FROM prediction_events WHERE prediction_id = $1 ORDER BY occurred_at',
    [prediction.id],
  );
  assert.deepEqual(events.map((e) => e.event_type), ['accepted', 'bounce']);

  const after = await queryOne('SELECT outcome FROM email_predictions WHERE id = $1', [prediction.id]);
  assert.equal(after.outcome, 'hard_bounce', 'the worse news wins');
});
