#!/usr/bin/env node
/**
 * Guided configuration for .env.
 *
 *   npm run setup            interactive
 *   npm run setup -- --list  show what is still outstanding, change nothing
 *
 * Passwords are read with the terminal echo suppressed and written straight
 * to .env - they are never printed back, never shown as a default, and never
 * placed on a command line where a shell would record them in history.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveProvider, providerFromHost } from '../src/config/providers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(serverRoot, '.env');
const examplePath = path.join(serverRoot, '.env.example');

const { values: flags } = parseArgs({ options: { list: { type: 'boolean', default: false } } });

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// A value that still needs a real answer.
const PLACEHOLDER = /^$|CHANGE[-_]?ME/i;
const isUnset = (value) => PLACEHOLDER.test(String(value ?? '').trim());

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(examplePath)) {
    console.error('Neither .env nor .env.example found.');
    process.exit(1);
  }
  fs.copyFileSync(examplePath, envPath);
  console.log(dim('Created .env from .env.example\n'));
}

function readEnv() {
  const text = fs.readFileSync(envPath, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map.set(match[1], match[2]);
  }
  return { text, map };
}

/** Rewrites values in place, preserving comments and ordering. */
function writeEnv(updates) {
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) text = text.replace(pattern, `${key}=${value}`);
    else text += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, text);
}

const { map: env } = readEnv();

const providerId = env.get('MAIL_PROVIDER') || providerFromHost(env.get('SMTP_HOST') ?? '');
const provider = resolveProvider(providerId, env.get('SMTP_HOST') ?? '');

/**
 * Fields in the order they are asked. `secret: true` suppresses echo and
 * hides the current value.
 */
const FIELDS = [
  {
    key: 'SENDING_DOMAIN',
    label: 'Sending domain',
    help: 'The domain mail is sent from, e.g. webknot.in',
    validate: (v) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? null : 'Not a valid domain'),
  },
  // Region only matters for providers that run several data centres.
  ...(provider.regions
    ? [{
      key: '_REGION',
      label: `${provider.label} data centre`,
      help: `Which region your account is in - check the URL you sign in with.\n  Options: ${Object.entries(provider.regions).map(([k, v]) => `${k} = ${v}`).join(', ')}\n  This must match the SPF include on your domain, or every message fails SPF.`,
      derive: () => provider.region ?? '',
      validate: (v) => (v in provider.regions ? null : `Must be one of: ${Object.keys(provider.regions).join(', ')}`),
    }]
    : []),
  {
    key: '_MAILBOX',
    label: 'Mailbox address',
    help: `The full address campaigns are sent from and replies arrive at.\n  Used for the From address, Reply-To, and both the SMTP and IMAP username.${
      provider.fromMustMatchUser
        ? `\n  ${provider.label} rewrites any other From address, so these must be the same.`
        : ''}`,
    derive: () => {
      const current = env.get('MAIL_FROM_ADDRESS') ?? '';
      return isUnset(current) ? '' : current;
    },
    validate: (v) => (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v) ? null : 'Not a valid email address'),
  },
  {
    key: 'MAIL_FROM_NAME',
    label: 'From name',
    help: 'The display name prospects see, e.g. "Avez at Webknot".\n  A personal name consistently outperforms a company name on cold outreach.',
    validate: (v) => (v.trim().length > 0 ? null : 'Required'),
  },
  {
    key: 'COMPANY_POSTAL_ADDRESS',
    label: 'Company postal address',
    help: 'A real registered address. Appended to every message - this is a legal\n  requirement for commercial email, and the linter blocks sending without it.',
    validate: (v) => (v.trim().length > 8 ? null : 'Required, and must be a real address'),
  },
  {
    key: 'SMTP_PASSWORD',
    label: `${provider.label} app password`,
    secret: true,
    help: 'Generate at: Zoho Account > Security > App Passwords.\n  Use an app-specific password, NOT your Zoho login password.\n  Input is hidden and the value is written straight to .env.',
    validate: (v) => (v.length >= 8 ? null : 'Looks too short for an app password'),
  },
];

// --- List mode -------------------------------------------------------------

function currentValueFor(field) {
  if (field.derive) return field.derive();
  return env.get(field.key) ?? '';
}

if (flags.list) {
  console.log(`\n${bold('Configuration status')}  ${dim(envPath)}\n`);

  let outstanding = 0;
  for (const field of FIELDS) {
    const value = currentValueFor(field);
    const unset = isUnset(value);
    if (unset) outstanding += 1;

    const shown = field.secret
      ? (unset ? red('not set') : green('set'))
      : (unset ? red('not set') : green(value));

    console.log(`  ${unset ? red('needs a value') : green('ok           ')}  ${field.label.padEnd(24)} ${shown}`);
  }

  const appUrl = env.get('APP_BASE_URL') ?? '';
  console.log(`\n  ${appUrl.includes('localhost') ? yellow('local only   ') : green('ok           ')}  ${'Public URL'.padEnd(24)} ${appUrl}`);
  if (appUrl.includes('localhost')) {
    console.log(dim('                   Unsubscribe links point here, so this must become a public'));
    console.log(dim('                   HTTPS URL before you send to anyone outside your machine.'));
  }

  console.log(outstanding === 0
    ? green('\n  Everything is set. Run `npm run check:dns` next.\n')
    : yellow(`\n  ${outstanding} value(s) outstanding. Run \`npm run setup\` to fill them in.\n`));

  process.exit(outstanding === 0 ? 0 : 1);
}

// --- Interactive mode ------------------------------------------------------

// Masking needs terminal mode, but terminal mode on piped stdin re-echoes
// the whole buffered input and then stalls. Follow whatever stdin actually
// is, so the script works both interactively and under automation.
const isTty = Boolean(process.stdin.isTTY);

// Piped input arrives as one burst: readline emits every line immediately,
// and any line that lands while no question() is pending is simply lost.
// So in non-TTY mode read the whole stream once and serve answers from it.
const piped = isTty ? [] : (await readAll(process.stdin)).split(/\r?\n/);

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const rl = isTty
  ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  : null;

function ask(question) {
  if (!isTty) {
    const answer = piped.shift() ?? '';
    process.stdout.write(`${question}${answer}\n`);
    return Promise.resolve(answer);
  }
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Same prompt with the typed characters suppressed.
 *
 * Without a TTY there is no echo to suppress - the shell is not printing the
 * piped bytes - so this falls back to a plain read rather than hanging.
 */
function askSecret(question) {
  if (!isTty) return ask(question);

  return new Promise((resolve) => {
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => {
      // Echo the prompt itself, but nothing the user types.
      if (text.includes(question.trim())) originalWrite(text);
      else originalWrite('');
    };

    rl.question(question, (answer) => {
      rl._writeToOutput = originalWrite;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

console.log(`\n${bold('mail-service-v2 setup')}`);
console.log(dim(`Writing to ${envPath}`));
console.log(dim('Press Enter to keep the current value shown in brackets.\n'));

const answers = {};

for (const field of FIELDS) {
  const current = currentValueFor(field);
  const unset = isUnset(current);

  console.log(bold(field.label));
  console.log(dim(`  ${field.help}`));

  const hint = field.secret
    ? (unset ? '' : ' [leave blank to keep the existing one]')
    : (unset ? '' : ` [${current}]`);

  let value = '';
  for (;;) {
    const raw = field.secret
      ? await askSecret(`  > ${hint ? `${hint.trim()} ` : ''}`)
      : await ask(`  >${hint} `);

    value = raw.trim() || (unset ? '' : current);

    // A secret left blank means "keep what is already there".
    if (field.secret && !raw.trim() && !unset) {
      value = null;
      break;
    }

    const problem = field.validate(value);
    if (!problem) break;
    console.log(red(`  ${problem}`));
  }

  if (value !== null) answers[field.key] = value;
  console.log('');
}

// Expand the two composite answers into the variables they drive, so a
// mismatch between SMTP and IMAP hosts or between From and username is
// impossible to introduce by hand.
const updates = {};

if (answers.SENDING_DOMAIN) updates.SENDING_DOMAIN = answers.SENDING_DOMAIN;
if (answers.MAIL_FROM_NAME) updates.MAIL_FROM_NAME = answers.MAIL_FROM_NAME;
if (answers.COMPANY_POSTAL_ADDRESS) updates.COMPANY_POSTAL_ADDRESS = answers.COMPANY_POSTAL_ADDRESS;

updates.MAIL_PROVIDER = provider.id;
if (answers._REGION) {
  const regional = provider.regionHosts(answers._REGION);
  updates.SMTP_HOST = regional.smtpHost;
  updates.IMAP_HOST = regional.imapHost;
} else {
  updates.SMTP_HOST = provider.smtpHost;
  updates.IMAP_HOST = provider.imapHost;
}
updates.DKIM_SELECTOR = provider.dkimSelector;

if (answers._MAILBOX) {
  updates.MAIL_FROM_ADDRESS = answers._MAILBOX;
  updates.MAIL_REPLY_TO = answers._MAILBOX;
  updates.SMTP_USER = answers._MAILBOX;
  updates.IMAP_USER = answers._MAILBOX;
}

if (answers.SMTP_PASSWORD) {
  updates.SMTP_PASSWORD = answers.SMTP_PASSWORD;
  // Zoho uses the same app password for both protocols.
  updates.IMAP_PASSWORD = answers.SMTP_PASSWORD;
}

updates.IMAP_ENABLED = 'true';

writeEnv(updates);
if (rl) rl.close();

console.log(green(`Saved to .env`));
console.log(dim(`  ${Object.keys(updates).filter((k) => !/PASSWORD/.test(k)).join(', ')}`));
if (updates.SMTP_PASSWORD) console.log(dim('  SMTP_PASSWORD, IMAP_PASSWORD (hidden)'));

const domain = updates.SENDING_DOMAIN ?? env.get('SENDING_DOMAIN');
const dc = answers._DATA_CENTRE ?? (env.get('SMTP_HOST') ?? '').match(/^smtp\.zoho\.(.+)$/)?.[1] ?? 'com';

console.log(`\n${bold('Next')}`);
console.log(`  1. npm run dns:plan -- --domain ${domain} --dc ${dc}   ${dim('# records to publish')}`);
console.log(`  2. npm run check:dns                                 ${dim('# verify once they are live')}`);
console.log(`  3. node scripts/smtp-test.js --to you@${domain}      ${dim('# real test send')}\n`);
