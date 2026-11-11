#!/usr/bin/env node
/**
 * Verifies SPF, DKIM and DMARC on the sending domain.
 *
 *   npm run check:dns
 *   node scripts/check-dns.js --mailbox 2
 *   node scripts/check-dns.js --domain acme.com --selector zoho
 *
 * The domain and selector default to a mailbox's own, because two mailboxes
 * can share a sending domain and still need different DKIM selectors - a
 * Google one publishes under `google`, a Zoho one under `zoho`.
 *
 * Exits non-zero if SPF or DKIM is failing, so it can gate a deploy.
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { checkDomain } from '../src/lib/dns-check.js';
import { loadMailboxes, allMailboxes, defaultMailbox } from '../src/db/repositories/mailboxes.js';
import { closePool } from '../src/db/index.js';

const { values } = parseArgs({
  options: {
    domain: { type: 'string' },
    selector: { type: 'string' },
    dc: { type: 'string' },
    mailbox: { type: 'string' },
  },
  allowPositionals: false,
});

await loadMailboxes();

const mailbox = values.mailbox
  ? allMailboxes().find((m) => String(m.id) === values.mailbox
      || m.label.toLowerCase() === values.mailbox.toLowerCase()
      || m.from_email.toLowerCase() === values.mailbox.toLowerCase())
  : defaultMailbox();

const domain = values.domain ?? mailbox?.sending_domain ?? env.SENDING_DOMAIN;
const selector = values.selector ?? mailbox?.dkim_selector ?? env.DKIM_SELECTOR;
// The preset carries the SPF include this provider requires, so the check
// verifies the right one rather than accepting any plausible include.
const provider = mailbox?.preset ?? env.provider;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(`\nChecking domain authentication for ${bold(domain)}`);
console.log(dim(`DKIM selector: ${selector}   Provider: ${provider.label}${provider.region ? ` (${provider.region})` : ''}\n`));

const result = await checkDomain(domain, selector, { provider });

for (const [label, check] of [
  ['SPF  ', result.spf],
  ['DKIM ', result.dkim],
  ['DMARC', result.dmarc],
]) {
  console.log(`${check.ok ? green('PASS') : red('FAIL')}  ${label}  ${check.summary}`);
  if (check.detail) {
    console.log(check.detail.split('\n').map((line) => dim(`        ${line}`)).join('\n'));
  }
}

if (result.passing) {
  console.log(green('\nSPF and DKIM are in place - the domain is ready to send.\n'));
} else {
  console.log(red('\nSPF and/or DKIM are failing. Fix these before sending any campaign -'));
  console.log(red('no amount of application-level tuning compensates for unauthenticated mail.\n'));
}

await closePool();
process.exit(result.passing ? 0 : 1);
