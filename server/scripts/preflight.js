#!/usr/bin/env node
/**
 * Checks everything that can be checked before credentials exist.
 *
 *   npm run preflight
 *
 * Confirms the Zoho hosts resolve, the ports are open, TLS negotiates and
 * the certificates are valid - so when you do add the app password, an
 * authentication failure means the password, not the network.
 */
import { env } from '../src/config/env.js';
import { resolveHost, probe } from '../src/lib/smtp-probe.js';
import { providerFromHost } from '../src/config/providers.js';

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

const provider = env.provider;
console.log(bold(`Provider: ${provider.label}${provider.region ? ` (${provider.region})` : ''}`));
console.log(dim(`      SPF include required: ${provider.spfInclude ?? 'unknown'}`));
console.log(dim(`      Daily ceiling: ~${provider.dailyLimit} messages`));
console.log('');

const targets = [
  { label: 'SMTP', host: env.SMTP_HOST, port: env.SMTP_PORT, implicitTls: env.smtpSecure, protocol: 'smtp' },
  ...(env.IMAP_ENABLED
    ? [{ label: 'IMAP', host: env.IMAP_HOST, port: env.IMAP_PORT, implicitTls: true, protocol: 'imap' }]
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
const sameProvider = !env.IMAP_ENABLED
  || providerFromHost(env.SMTP_HOST) === providerFromHost(env.IMAP_HOST);
line(sameProvider, 'SMTP and IMAP are the same provider',
  sameProvider ? `both ${provider.label}` : `${env.SMTP_HOST} and ${env.IMAP_HOST} do not match`);

// Gmail silently rewrites a From that is not the authenticated mailbox or a
// verified alias, which breaks branding and DKIM alignment at once.
if (provider.fromMustMatchUser) {
  const matches = env.MAIL_FROM_ADDRESS.toLowerCase() === env.SMTP_USER.toLowerCase();
  line(matches, 'From address matches the authenticated mailbox',
    matches
      ? env.MAIL_FROM_ADDRESS
      : `${provider.label} will rewrite From to ${env.SMTP_USER} unless ${env.MAIL_FROM_ADDRESS} is a verified "Send mail as" alias`);
}

const fromDomain = env.MAIL_FROM_ADDRESS.split('@')[1] ?? '';
line(fromDomain.toLowerCase() === env.SENDING_DOMAIN.toLowerCase(),
  'From address is on the sending domain',
  fromDomain.toLowerCase() === env.SENDING_DOMAIN.toLowerCase()
    ? `${env.MAIL_FROM_ADDRESS}`
    : `${env.MAIL_FROM_ADDRESS} is not on ${env.SENDING_DOMAIN} - DKIM will not align and DMARC will fail`);

const placeholder = /CHANGE[-_]?ME/i;
const unset = Object.entries({
  MAIL_FROM_ADDRESS: env.MAIL_FROM_ADDRESS,
  SMTP_USER: env.SMTP_USER,
  SMTP_PASSWORD: env.SMTP_PASSWORD,
  COMPANY_POSTAL_ADDRESS: env.COMPANY_POSTAL_ADDRESS,
}).filter(([, value]) => placeholder.test(String(value))).map(([key]) => key);

line(unset.length === 0, 'Credentials and identity filled in',
  unset.length === 0 ? 'all set' : `still placeholders: ${unset.join(', ')} - run: npm run setup`);

line(!env.APP_BASE_URL.includes('localhost'), 'Public base URL set',
  env.APP_BASE_URL.includes('localhost')
    ? `${env.APP_BASE_URL} - unsubscribe links will only work locally`
    : env.APP_BASE_URL);

console.log(failures === 0
  ? green('\nAll preflight checks passed.\n')
  : yellow(`\n${failures} check(s) outstanding. Network-level failures above are worth fixing first.\n`));

process.exit(failures === 0 ? 0 : 1);
