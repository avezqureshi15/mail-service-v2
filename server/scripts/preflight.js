#!/usr/bin/env node
/**
 * Checks everything about a mailbox that can be checked without sending.
 *
 *   npm run preflight
 *   npm run preflight -- --mailbox 2
 *
 * Confirms the hosts resolve, the ports are open, TLS negotiates and the
 * certificates are valid - so when authentication does fail, it means the
 * password rather than the network.
 *
 * Reads the mailbox from the database, not .env, so it diagnoses the account
 * the service will actually send from. Without --mailbox it uses the default.
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { resolveHost, probe } from '../src/lib/smtp-probe.js';
import { providerFromHost } from '../src/config/providers.js';
import { loadMailboxes, allMailboxes, defaultMailbox } from '../src/db/repositories/mailboxes.js';
import { closePool } from '../src/db/index.js';

const { values: args } = parseArgs({ options: { mailbox: { type: 'string' } }, strict: false });

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
const line = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? green('PASS') : red('FAIL')}  ${label}`);
  if (detail) console.log(dim(`      ${detail}`));
};

console.log(`\n${bold('Preflight')}  ${dim('(no credentials are sent)')}\n`);

await loadMailboxes();

const mailbox = args.mailbox
  ? allMailboxes().find((m) => String(m.id) === args.mailbox
      || m.label.toLowerCase() === args.mailbox.toLowerCase()
      || m.from_email.toLowerCase() === args.mailbox.toLowerCase())
  : defaultMailbox();

if (!mailbox) {
  const known = allMailboxes().map((m) => `${m.id}: ${m.label} <${m.from_email}>`);
  console.log(red(args.mailbox ? `No mailbox matching "${args.mailbox}".` : 'No default mailbox configured.'));
  if (known.length) {
    console.log('');
    console.log('Known mailboxes:');
    for (const k of known) console.log(`  ${k}`);
    console.log('');
  } else {
    console.log('');
    console.log('Add one in Settings > Mailboxes.');
    console.log('');
  }
  await closePool();
  process.exit(1);
}

const provider = mailbox.preset;
console.log(bold(`Mailbox: ${mailbox.label} <${mailbox.from_email}>`));
console.log(bold(`Provider: ${provider.label}${provider.region ? ` (${provider.region})` : ''}`));
console.log(dim(`      SPF include required: ${provider.spfInclude ?? 'unknown'}`));
console.log(dim(`      Daily ceiling: ~${provider.dailyLimit} messages`));
console.log('');

const targets = [
  { label: 'SMTP', host: mailbox.smtp_host, port: mailbox.smtp_port, implicitTls: mailbox.smtp_port === 465, protocol: 'smtp' },
  ...(mailbox.imap_enabled
    ? [{ label: 'IMAP', host: mailbox.imap_host, port: mailbox.imap_port, implicitTls: true, protocol: 'imap' }]
    : []),
];

for (const target of targets) {
  console.log(bold(`${target.label}  ${target.host}:${target.port}`));

  const dns = await resolveHost(target.host);
  line(dns.ok, `${target.label} host resolves`,
    dns.ok ? dns.addresses.slice(0, 3).join(', ') : `DNS lookup failed: ${dns.error}`);

  if (!dns.ok) {
    console.log(dim('      Check the host matches your Zoho data centre.\n'));
    continue;
  }

  const result = await probe(target.host, target.port, { implicitTls: target.implicitTls, protocol: target.protocol });

  line(result.ok, `${target.label} port ${target.port} open and responding`,
    result.ok ? `${result.greeting} ${dim(`(${result.ms}ms)`)}` : result.error);

  if (result.tls) {
    line(result.tls.authorized, `${target.label} TLS certificate valid`,
      result.tls.authorized
        ? `${result.tls.protocol}, ${result.tls.cipher}, CN=${result.tls.subject}, expires ${result.tls.validTo}`
        : `${result.tls.authorizationError} - do NOT disable certificate validation to work around this`);
  }

  console.log('');
}

// Config consistency. A mismatch here authenticates nothing and is invisible
// in the records themselves.
console.log(bold('Configuration'));

// Both hosts must belong to the same provider, or one half of the service
// authenticates somewhere the other does not.
const sameProvider = !mailbox.imap_enabled
  || providerFromHost(mailbox.smtp_host) === providerFromHost(mailbox.imap_host);
line(sameProvider, 'SMTP and IMAP are the same provider',
  sameProvider ? `both ${provider.label}` : `${mailbox.smtp_host} and ${mailbox.imap_host} do not match`);

// Gmail silently rewrites a From that is not the authenticated mailbox or a
// verified alias, which breaks branding and DKIM alignment at once.
if (provider.fromMustMatchUser) {
  const matches = mailbox.from_email.toLowerCase() === mailbox.smtp_user.toLowerCase();
  line(matches, 'From address matches the authenticated mailbox',
    matches
      ? mailbox.from_email
      : `${provider.label} will rewrite From to ${mailbox.smtp_user} unless ${mailbox.from_email} is a verified "Send mail as" alias`);
}

const fromDomain = mailbox.from_email.split('@')[1] ?? '';
line(fromDomain.toLowerCase() === mailbox.sending_domain.toLowerCase(),
  'From address is on the sending domain',
  fromDomain.toLowerCase() === mailbox.sending_domain.toLowerCase()
    ? `${mailbox.from_email}`
    : `${mailbox.from_email} is not on ${mailbox.sending_domain} - DKIM will not align and DMARC will fail`);

const placeholder = /CHANGE[-_]?ME/i;
const unset = Object.entries({
  'mailbox from address': mailbox.from_email,
  'mailbox SMTP username': mailbox.smtp_user,
  COMPANY_POSTAL_ADDRESS: env.COMPANY_POSTAL_ADDRESS,
}).filter(([, value]) => placeholder.test(String(value))).map(([key]) => key);

line(unset.length === 0, 'Identity filled in',
  unset.length === 0 ? 'all set' : `still placeholders: ${unset.join(', ')}`);

line(Boolean(mailbox.last_verified_at), 'Credentials verified at least once',
  mailbox.last_verified_at
    ? `last verified ${new Date(mailbox.last_verified_at).toISOString()}`
    : 'never - use Test connection in Settings > Mailboxes, or npm run check:smtp');

line(!env.APP_BASE_URL.includes('localhost'), 'Public base URL set',
  env.APP_BASE_URL.includes('localhost')
    ? `${env.APP_BASE_URL} - unsubscribe links will only work locally`
    : env.APP_BASE_URL);

console.log(failures === 0
  ? green('\nAll preflight checks passed.\n')
  : yellow(`\n${failures} check(s) outstanding. Network-level failures above are worth fixing first.\n`));

process.exit(failures === 0 ? 0 : 1);
