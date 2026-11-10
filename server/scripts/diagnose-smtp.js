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
import { env } from '../src/config/env.js';
import { verifyTransport, closeTransport } from '../src/mail/transport.js';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const pw = env.SMTP_PASSWORD ?? '';
const problems = [];

console.log(`\n${bold('SMTP credential diagnosis')}\n`);

console.log(`  Provider   : ${env.provider.label}`);
console.log(`  Host       : ${env.SMTP_HOST}:${env.SMTP_PORT}`);
console.log(`  Username   : ${env.SMTP_USER}`);
console.log(`  From       : ${env.MAIL_FROM_ADDRESS}`);
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
if (env.provider.id === 'google' && pw && !/CHANGE[_-]?ME/i.test(pw) && stripped.length !== 16) {
  problems.push({
    fatal: false,
    title: `Google app passwords are 16 characters; this one is ${stripped.length}`,
    fix: stripped.length > 16
      ? 'This looks like an account password rather than an app password. App passwords are generated '
        + 'at https://myaccount.google.com/apppasswords and are exactly 16 letters.'
      : 'Check for a truncated paste.',
  });
}

if (env.SMTP_USER.toLowerCase() !== env.MAIL_FROM_ADDRESS.toLowerCase()) {
  problems.push({
    fatal: false,
    title: 'The username and From address are different mailboxes',
    fix: `Gmail rewrites From unless ${env.MAIL_FROM_ADDRESS} is a verified "Send mail as" alias of ${env.SMTP_USER}.`,
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
  await verifyTransport();
  console.log(green('PASS  The credentials are accepted.\n'));
  console.log('Send a real test message with:');
  console.log(dim(`  node scripts/smtp-test.js --to ${env.SMTP_USER}\n`));
  await closeTransport();
  process.exit(0);
} catch (error) {
  const message = error.message ?? String(error);
  console.log(red(`FAIL  ${message}\n`));

  if (/535|BadCredentials|Username and Password not accepted/i.test(message)) {
    console.log(bold('Google rejected the username/password pair. In order of likelihood:\n'));
    console.log('  1. The server has not reloaded .env.');
    console.log(dim('     Watch mode only watches src/, so a .env edit needs a manual restart.\n'));
    console.log('  2. Spaces were kept in the app password.');
    console.log(dim('     It must be the 16 characters with no spaces.\n'));
    console.log('  3. It is the account password, not an app password.');
    console.log(dim('     Generate one at https://myaccount.google.com/apppasswords\n'));
    console.log('  4. Two-Step Verification is off for the account.');
    console.log(dim('     App passwords do not exist without it - the page will not offer one.\n'));
    console.log('  5. The app password belongs to a different account than SMTP_USER.');
    console.log(dim(`     It must have been generated while signed in as ${env.SMTP_USER}.\n`));
    console.log('  6. A Workspace admin has blocked SMTP sign-in for the domain.');
    console.log(dim('     Admin console > Security > Less secure apps / Connected apps.\n'));
  }

  await closeTransport();
  process.exit(1);
}
