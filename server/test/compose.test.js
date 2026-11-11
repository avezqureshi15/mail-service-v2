import test from 'node:test';
import assert from 'node:assert/strict';

import { composeMessage, renderMergeFields, sanitizeBody } from '../src/mail/compose.js';
import { htmlToText } from '../src/mail/plaintext.js';
import { lintContent } from '../src/mail/spam-lint.js';
import {
  createUnsubscribeToken,
  readUnsubscribeToken,
  createClickToken,
  readClickToken,
  verifyToken,
} from '../src/mail/tokens.js';
import { looksLikeBot } from '../src/mail/tracking.js';
import { env } from '../src/config/env.js';

const contact = {
  id: 7,
  email: 'dana@acme.test',
  first_name: 'Dana',
  last_name: 'Ortiz',
  company: 'Acme',
  custom_fields: JSON.stringify({ city: 'Pune' }),
};

// Deliberately NOT env.SENDING_DOMAIN: the Message-ID must follow the
// mailbox that sends, and asserting against a distinct domain is what proves
// it stopped following the old process-wide value.
const mailbox = {
  id: 1,
  label: 'Test mailbox',
  from_name: 'Mailbox Default',
  from_email: 'sender@mailbox.test',
  reply_to: '',
  sending_domain: 'mailbox.test',
  smtp_host: 'smtp.mailbox.test',
  smtp_port: 465,
  smtp_user: 'sender@mailbox.test',
  is_active: true,
};

const campaign = {
  id: 3,
  subject: 'Quick question, {{first_name}}',
  html_body: '<p>Hi {{first_name}} at {{company}} in {{city}}.</p><p><a href="https://acme.test/demo">Book a demo</a></p>',
  from_name: 'Sam Rivera',
  from_email: 'sam@example.com',
  reply_to: 'sam@example.com',
  tracking_enabled: 0,
};

const step = { subject: '', html_body: '' };

test('merge fields are substituted and HTML-escaped', () => {
  const out = renderMergeFields('Hello {{first_name}} from {{company}}', {
    ...contact,
    first_name: '<script>x</script>Dana',
  });
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /<script>/);
});

test('unknown merge fields are left intact rather than blanked', () => {
  const out = renderMergeFields('Hi {{nope}}', contact);
  assert.equal(out, 'Hi {{nope}}');
});

test('sanitizer strips script, iframe and event handlers', () => {
  const dirty = '<p onclick="steal()">hi</p><script>bad()</script><iframe src="https://x"></iframe><a href="javascript:bad()">x</a>';
  const clean = sanitizeBody(dirty);
  assert.doesNotMatch(clean, /script|iframe|onclick|javascript:/i);
  assert.match(clean, /<p>hi<\/p>/);
});

test('composed message has a real plaintext part and both unsubscribe headers', () => {
  const { message, messageId } = composeMessage({ campaign, step, contact, mailbox });

  assert.ok(message.text.length > 20, 'plaintext part must not be empty');
  assert.match(message.text, /Hi Dana at Acme in Pune/);
  assert.match(message.subject, /^Quick question, Dana$/);

  const unsub = message.headers['List-Unsubscribe'];
  assert.match(unsub, /^<https?:\/\/[^>]+>, <mailto:[^>]+>$/);
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  // The Message-ID must sit on the configured sending domain, whatever that
  // is - bounce and reply matching both key off recognising it later.
  assert.ok(
    messageId.endsWith(`@${mailbox.sending_domain}>`),
    `Message-ID ${messageId} should be on ${mailbox.sending_domain}`,
  );
});

test('footer with unsubscribe link and postal address is injected automatically', () => {
  const { message, unsubscribeUrl } = composeMessage({ campaign, step, contact, mailbox });
  assert.ok(message.html.includes(unsubscribeUrl), 'visible unsubscribe link missing');
  assert.match(message.html, /Unsubscribe/);
  // CAN-SPAM requires a postal address in every commercial message, and it is
  // injected from configuration rather than written by the campaign author.
  assert.ok(
    message.text.includes(env.COMPANY_POSTAL_ADDRESS),
    'configured postal address missing from the plaintext part',
  );
});

test('preheader is injected as hidden preview text, merge fields and all', () => {
  const { message } = composeMessage({
    mailbox,
    campaign: { ...campaign, preheader: 'A note for {{first_name}} at {{company}}' },
    step,
    contact,
  });
  assert.match(message.html, /display:none[^>]*>A note for Dana at Acme/);
});

test('a step-level preheader overrides the campaign default', () => {
  const { message } = composeMessage({
    campaign: { ...campaign, preheader: 'Campaign default' },
    step: { ...step, preheader: 'Step-specific preview' },
    contact,
    mailbox,
  });
  assert.match(message.html, /Step-specific preview/);
  assert.doesNotMatch(message.html, /Campaign default/);
});

test('no preheader markup when neither campaign nor step set one', () => {
  const { message } = composeMessage({ campaign, step, contact, mailbox });
  assert.doesNotMatch(message.html, /mso-hide:all/);
});

test('follow-up steps thread onto the original message', () => {
  const { message } = composeMessage({
    campaign,
    mailbox,
    step: { subject: 'Following up', html_body: '<p>Bumping this.</p>' },
    contact,
    threadMessageId: '<original@example.com>',
  });
  assert.equal(message.headers['In-Reply-To'], '<original@example.com>');
  assert.equal(message.headers.References, '<original@example.com>');
});

test('no tracking pixel or rewritten links when tracking is off', () => {
  const { message } = composeMessage({ campaign, step, contact, mailbox });
  assert.doesNotMatch(message.html, /\/t\/o\//, 'open pixel must be absent');
  assert.doesNotMatch(message.html, /\/t\/c\//, 'click rewriting must be absent');
  assert.match(message.html, /href="https:\/\/acme\.test\/demo"/);
});

test('unsubscribe token round-trips and rejects tampering', () => {
  const token = createUnsubscribeToken({ contactId: 7, campaignId: 3, email: 'dana@acme.test' });
  const read = readUnsubscribeToken(token);
  assert.deepEqual(read, { contactId: 7, campaignId: 3, email: 'dana@acme.test' });

  // Flip a character in the payload; the signature must no longer match.
  const [body, sig] = token.split('.');
  const tamperedBody = `${body.slice(0, -1)}${body.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(readUnsubscribeToken(`${tamperedBody}.${sig}`), null);
  assert.equal(readUnsubscribeToken(`${body}.${sig.slice(0, -1)}X`), null);
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(''), null);
});

test('token types are not interchangeable', () => {
  // An unsubscribe token must not be accepted by the click-redirect reader,
  // or a crafted link could redirect anywhere.
  const unsub = createUnsubscribeToken({ contactId: 1, campaignId: 1, email: 'a@b.test' });
  assert.equal(readClickToken(unsub), null);

  const click = createClickToken({ contactId: 1, campaignId: 1, messageId: 'm', url: 'https://ok.test' });
  assert.equal(readUnsubscribeToken(click), null);
  assert.equal(readClickToken(click).url, 'https://ok.test');
});

test('linter blocks the legally required omissions and shorteners', () => {
  const result = lintContent({
    subject: 'Hello',
    html: '<p>Some reasonable body text that goes on for a little while here.</p><a href="https://bit.ly/abc">link</a>',
    sendingDomain: 'example.com',
    hasUnsubscribe: false,
    hasPostalAddress: false,
  });

  assert.equal(result.canSend, false);
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes('no_unsubscribe'));
  assert.ok(codes.includes('no_postal_address'));
  assert.ok(codes.includes('url_shortener'));
});

test('linter passes a clean message', () => {
  const result = lintContent({
    subject: 'Quick question about your hiring process',
    html: '<p>Hi {{first_name}}, I noticed {{company}} is expanding the support team this quarter. We help teams in that position cut onboarding time by about a third. Worth a short call next week to see whether it maps onto what you are doing?</p><p><a href="https://example.com/demo">See a two-minute overview</a></p>',
    sendingDomain: 'example.com',
    hasUnsubscribe: true,
    hasPostalAddress: true,
  });

  assert.equal(result.canSend, true);
  assert.ok(result.score >= 85, `expected a good score, got ${result.score}`);
});

test('htmlToText keeps link destinations and drops markup', () => {
  const text = htmlToText('<p>Hi</p><p><a href="https://x.test/a">Click</a></p><script>bad()</script>');
  assert.match(text, /Click <https:\/\/x\.test\/a>/);
  assert.doesNotMatch(text, /bad\(\)|<p>/);
});

test('bot filter catches gateway prefetch and instant opens', () => {
  assert.equal(looksLikeBot('GoogleImageProxy'), true);
  assert.equal(looksLikeBot('Mozilla/5.0 ... Proofpoint'), true);
  assert.equal(looksLikeBot(''), true);
  // A real read, two minutes after delivery.
  assert.equal(looksLikeBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15', 120), false);
  // Same agent, but one second after the send - that is a scanner.
  assert.equal(looksLikeBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15', 1), true);
});
