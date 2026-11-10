#!/usr/bin/env node
/**
 * Verifies the Zoho SMTP connection and optionally sends one real message.
 *
 *   npm run check:smtp
 *   node scripts/smtp-test.js --to you@yourdomain.com
 *
 * The test message goes through the real composer, so what lands in your
 * inbox has the same headers, footer and plain-text part as a campaign send.
 * Open it with "Show original" to confirm SPF/DKIM/DMARC all pass.
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { getTransport, verifyTransport, closeTransport } from '../src/mail/transport.js';
import { composeMessage } from '../src/mail/compose.js';

const { values } = parseArgs({ options: { to: { type: 'string' } } });

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(`\n${env.provider.label} - ${env.SMTP_HOST}:${env.SMTP_PORT} (${env.smtpSecure ? 'implicit TLS' : 'STARTTLS required'}) as ${env.SMTP_USER}\n`);

try {
  await verifyTransport();
  console.log(green('PASS  Connection, TLS and authentication all succeeded.'));
} catch (error) {
  console.log(red(`FAIL  ${error.message}`));
  if (/invalid login|authentication failed|535/i.test(error.message)) {
    console.log(dim(`      ${env.provider.label} requires an app-specific password when two-factor auth is on.`));
    if (env.provider.appPasswordUrl) console.log(dim(`      Generate one at: ${env.provider.appPasswordUrl}`));
  }
  if (/ENOTFOUND|ETIMEDOUT/i.test(error.message)) {
    console.log(dim(`      Check SMTP_HOST is right for ${env.provider.label} (expected ${env.provider.smtpHost}).`));
  }
  await closeTransport();
  process.exit(1);
}

if (!values.to) {
  console.log(dim('\nNo --to given, so no test message was sent.'));
  console.log(dim('Run with --to you@yourdomain.com to send one.\n'));
  await closeTransport();
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
    from_name: env.MAIL_FROM_NAME,
    from_email: env.MAIL_FROM_ADDRESS,
    reply_to: env.replyTo,
    tracking_enabled: 0,
  },
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
  const info = await (await getTransport()).sendMail(message);
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
    console.log(dim(`      ${env.provider.dailyLimitNote}`));
    console.log(dim('      If this appears during normal operation, lower the daily cap in Settings.'));
  }
  await closeTransport();
  process.exit(1);
}

await closeTransport();
