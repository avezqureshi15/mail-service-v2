#!/usr/bin/env node
/**
 * Verifies a mailbox's SMTP connection and optionally sends one real message.
 *
 *   npm run check:smtp
 *   node scripts/smtp-test.js --to you@yourdomain.com
 *   node scripts/smtp-test.js --mailbox 2 --to you@yourdomain.com
 *
 * Credentials come from the `mailboxes` table now, not .env, so this
 * diagnoses the account the service will actually send from. Without
 * --mailbox it uses the default one.
 *
 * The test message goes through the real composer, so what lands in your
 * inbox has the same headers, footer and plain-text part as a campaign send.
 * Open it with "Show original" to confirm SPF/DKIM/DMARC all pass.
 */
import { parseArgs } from 'node:util';
import { getTransport, verifyTransport, closeAllTransports } from '../src/mail/transport.js';
import { composeMessage } from '../src/mail/compose.js';
import { loadMailboxes, allMailboxes, defaultMailbox } from '../src/db/repositories/mailboxes.js';
import { closePool } from '../src/db/index.js';

const { values } = parseArgs({ options: { to: { type: 'string' }, mailbox: { type: 'string' } } });

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

await loadMailboxes();

const mailbox = values.mailbox
  ? allMailboxes().find((m) => String(m.id) === values.mailbox
      || m.label.toLowerCase() === values.mailbox.toLowerCase()
      || m.from_email.toLowerCase() === values.mailbox.toLowerCase())
  : defaultMailbox();

if (!mailbox) {
  const known = allMailboxes().map((m) => `${m.id}: ${m.label} <${m.from_email}>`);
  console.log(red(values.mailbox
    ? `No mailbox matching "${values.mailbox}".`
    : 'No default mailbox configured.'));
  console.log(known.length
    ? `Known mailboxes:` + known.map((k) => `\n  ` + k).join('')
    : 'Add one in Settings > Mailboxes.');
  await closePool();
  process.exit(1);
}

const implicitTls = mailbox.smtp_port === 465;
console.log(`\n${mailbox.label} - ${mailbox.smtp_host}:${mailbox.smtp_port} (${implicitTls ? 'implicit TLS' : 'STARTTLS required'}) as ${mailbox.smtp_user}\n`);

try {
  await verifyTransport(mailbox);
  console.log(green('PASS  Connection, TLS and authentication all succeeded.'));
} catch (error) {
  console.log(red(`FAIL  ${error.message}`));
  if (/invalid login|authentication failed|535/i.test(error.message)) {
    console.log(dim(`      ${mailbox.preset.label} requires an app-specific password when two-factor auth is on.`));
    if (mailbox.preset.appPasswordUrl) console.log(dim(`      Generate one at: ${mailbox.preset.appPasswordUrl}`));
  }
  if (/ENOTFOUND|ETIMEDOUT/i.test(error.message)) {
    console.log(dim(`      Check the host is right for ${mailbox.preset.label} (expected ${mailbox.preset.smtpHost}).`));
  }
  await closeAllTransports();
  await closePool();
  process.exit(1);
}

if (!values.to) {
  console.log(dim('\nNo --to given, so no test message was sent.'));
  console.log(dim('Run with --to you@yourdomain.com to send one.\n'));
  await closeAllTransports();
  await closePool();
  process.exit(0);
}

const { message, messageId } = composeMessage({
  campaign: {
    // Not a real row: null so the unsubscribe token carries no id
    // rather than a phantom 0 that no table can satisfy.
    id: null,
    subject: 'mail-service-v2 deliverability test',
    html_body:
      '<p>Hi {{first_name}},</p>'
      + '<p>This is a test message from mail-service-v2. If you are reading it in your inbox rather than the spam folder, the sending path is working.</p>'
      + '<p>Open <strong>Show original</strong> (Gmail) or <strong>View source</strong> and confirm all three of SPF, DKIM and DMARC report PASS.</p>'
      + '<p>You should also see your mail client offer its own Unsubscribe control next to the sender name.</p>',
    from_name: '',
    from_email: '',
    reply_to: '',
    tracking_enabled: 0,
  },
  mailbox,
  step: { subject: '', html_body: '' },
  contact: {
    // Not a real row: null so the unsubscribe token carries no id
    // rather than a phantom 0 that no table can satisfy.
    id: null,
    email: values.to,
    first_name: 'there',
    last_name: '',
    company: '',
    custom_fields: '{}',
  },
});

try {
  const info = await (await getTransport(mailbox)).sendMail(message);
  console.log(green(`PASS  Test message accepted for ${values.to}`));
  console.log(dim(`      Message-ID: ${messageId}`));
  console.log(dim(`      Server response: ${info.response}`));
  console.log('\nNow check the inbox:');
  console.log('  1. Did it land in Inbox rather than Spam or Promotions?');
  console.log('  2. Does "Show original" report SPF: PASS, DKIM: PASS, DMARC: PASS?');
  console.log('  3. Does the client show its own Unsubscribe link beside the sender?\n');
} catch (error) {
  console.log(red(`FAIL  Send rejected: ${error.message}`));
  if (/limit|quota|exceeded|554|552/i.test(error.message)) {
    console.log(dim(`      ${mailbox.preset.dailyLimitNote}`));
    console.log(dim('      If this appears during normal operation, lower the daily cap in Settings.'));
  }
  await closeAllTransports();
  await closePool();
  process.exit(1);
}

await closeAllTransports();
await closePool();
