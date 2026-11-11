#!/usr/bin/env node
/**
 * Works out why an SMTP login is being rejected.
 *
 *   npm run diagnose:smtp
 *
 * Checks the shape of the configured credentials and then attempts a real
 * login, translating the provider's response into the actual cause. The
 * password is never printed, logged or echoed - only facts about it, such as
 * its length and whether it contains spaces.
 */
import { parseArgs } from 'node:util';
import { verifyTransport, closeAllTransports } from '../src/mail/transport.js';
import {
  loadMailboxes, allMailboxes, defaultMailbox, mailboxSecrets,
} from '../src/db/repositories/mailboxes.js';
import { closePool } from '../src/db/index.js';

const { values: args } = parseArgs({ options: { mailbox: { type: 'string' } }, strict: false });

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

await loadMailboxes();

const mailbox = args.mailbox
  ? allMailboxes().find((m) => String(m.id) === args.mailbox
      || m.label.toLowerCase() === args.mailbox.toLowerCase()
      || m.from_email.toLowerCase() === args.mailbox.toLowerCase())
  : defaultMailbox();

if (!mailbox) {
  console.log(red(args.mailbox ? `No mailbox matching "${args.mailbox}".` : 'No mailbox configured.'));
  for (const m of allMailboxes()) console.log(`  ${m.id}: ${m.label} <${m.from_email}>`);
  await closePool();
  process.exit(1);
}

// Decrypted here and nowhere else, and only facts about it are printed.
const { smtpPassword: pw } = await mailboxSecrets(mailbox.id);
const problems = [];

console.log(`\n${bold('SMTP credential diagnosis')}\n`);

console.log(`  Mailbox    : ${mailbox.label}`);
console.log(`  Provider   : ${mailbox.preset.label}`);
console.log(`  Host       : ${mailbox.smtp_host}:${mailbox.smtp_port}`);
console.log(`  Username   : ${mailbox.smtp_user}`);
console.log(`  From       : ${mailbox.from_email}`);
console.log(`  Password   : ${pw.length} characters ${dim('(value never shown)')}\n`);

// --- Shape checks, before spending a round trip -----------------------------

if (/CHANGE[_-]?ME/i.test(pw)) {
  problems.push({
    fatal: true,
    title: 'The password is still the placeholder',
    fix: 'Run `npm run setup` and enter a real app password. Editing .env by hand works too.',
  });
}

if (pw && /\s/.test(pw)) {
  problems.push({
    fatal: true,
    title: 'The password contains spaces',
    fix: 'Google shows app passwords as four groups of four ("abcd efgh ijkl mnop"), but they must '
      + 'be entered as 16 characters with no spaces. Remove them.',
  });
}

if (/^["']|["']$/.test(pw)) {
  problems.push({
    fatal: true,
    title: 'The password is wrapped in quotes',
    fix: 'Values in .env are taken literally, so the quotes become part of the password. Remove them.',
  });
}

const stripped = pw.replace(/\s/g, '');
if (mailbox.preset.id === 'google' && pw && !/CHANGE[_-]?ME/i.test(pw) && stripped.length !== 16) {
  problems.push({
    fatal: false,
    title: `Google app passwords are 16 characters; this one is ${stripped.length}`,
    fix: stripped.length > 16
      ? 'This looks like an account password rather than an app password. App passwords are generated '
        + 'at https://myaccount.google.com/apppasswords and are exactly 16 letters.'
      : 'Check for a truncated paste.',
  });
}

if (mailbox.smtp_user.toLowerCase() !== mailbox.from_email.toLowerCase()) {
  problems.push({
    fatal: false,
    title: 'The username and From address are different mailboxes',
    fix: `${mailbox.preset.label} may rewrite From unless ${mailbox.from_email} is a verified "Send mail as" alias of ${mailbox.smtp_user}.`,
  });
}

for (const p of problems) {
  console.log(`${p.fatal ? red('PROBLEM') : yellow('WARNING')}  ${p.title}`);
  console.log(dim(`         ${p.fix}\n`));
}

if (problems.some((p) => p.fatal)) {
  console.log(red('Fix the above and run this again - the login will fail until then.\n'));
  process.exit(1);
}

// --- Real login -------------------------------------------------------------

console.log(dim('Attempting a real login...\n'));

try {
  await verifyTransport(mailbox);
  console.log(green('PASS  The credentials are accepted.\n'));
  console.log('Send a real test message with:');
  console.log(dim(`  node scripts/smtp-test.js --mailbox ${mailbox.id} --to ${mailbox.smtp_user}\n`));
  await closeAllTransports();
  await closePool();
  process.exit(0);
} catch (error) {
  const message = error.message ?? String(error);
  console.log(red(`FAIL  ${message}\n`));

  if (/535|BadCredentials|Username and Password not accepted/i.test(message)) {
    console.log(bold('Google rejected the username/password pair. In order of likelihood:\n'));
    console.log('  1. The password stored for this mailbox is out of date.');
    console.log(dim('     Re-enter it under Settings > Mailboxes; a saved change takes effect on the next send, no restart needed.'));
    console.log('  2. Spaces were kept in the app password.');
    console.log(dim('     It must be the 16 characters with no spaces.\n'));
    console.log('  3. It is the account password, not an app password.');
    console.log(dim('     Generate one at https://myaccount.google.com/apppasswords\n'));
    console.log('  4. Two-Step Verification is off for the account.');
    console.log(dim('     App passwords do not exist without it - the page will not offer one.\n'));
    console.log('  5. The app password belongs to a different account than SMTP_USER.');
    console.log(dim(`     It must have been generated while signed in as ${mailbox.smtp_user}.\n`));
    console.log('  6. A Workspace admin has blocked SMTP sign-in for the domain.');
    console.log(dim('     Admin console > Security > Less secure apps / Connected apps.\n'));
  }

  await closeAllTransports();
  await closePool();
  process.exit(1);
}
