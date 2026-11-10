#!/usr/bin/env node
/**
 * Reads the live DNS for a domain and prints the exact records to publish so
 * the chosen provider can send alongside whatever already sends for it.
 *
 *   node scripts/dns-plan.js --domain webknot.in --provider google
 *   node scripts/dns-plan.js --domain webknot.in --provider zoho --dc in
 *
 * It never changes anything. The point is a change list computed from what
 * is actually published, because the dangerous mistake here is replacing an
 * existing SPF record and silently breaking normal company mail.
 */
import { Resolver } from 'node:dns/promises';
import { parseArgs } from 'node:util';
import { resolveSpf, detectProviders, MAX_LOOKUPS } from '../src/lib/spf.js';
import { resolveProvider } from '../src/config/providers.js';

const { values } = parseArgs({
  options: {
    domain: { type: 'string' },
    provider: { type: 'string', default: 'google' },
    dc: { type: 'string' },
    selector: { type: 'string' },
  },
});

if (!values.domain) {
  console.error('Usage: node scripts/dns-plan.js --domain example.com [--provider google|zoho] [--dc in] [--selector name]');
  process.exit(1);
}

const domain = values.domain.toLowerCase();
// A data centre is only meaningful for providers that have regions.
const provider = resolveProvider(values.provider, values.dc ? `smtp.zoho.${values.dc}` : '');
const required = provider.spfInclude;
const selector = values.selector ?? provider.dkimSelector;

const resolver = new Resolver({ timeout: 5000 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function txt(name) {
  try {
    return (await resolver.resolveTxt(name)).map((c) => c.join(''));
  } catch {
    return [];
  }
}

const regionLabel = provider.region ? ` ${provider.region}` : '';
console.log(`\n${bold(`DNS plan for ${domain}`)}  ${dim(`(provider: ${provider.label}${regionLabel})`)}\n`);

// --- What is there now -----------------------------------------------------

const mx = await resolver.resolveMx(domain).catch(() => []);
const mxHosts = mx.map((m) => m.exchange.toLowerCase());
const inboundProvider = mxHosts.some((h) => h.includes('google')) ? 'Google Workspace'
  : mxHosts.some((h) => h.includes('outlook') || h.includes('microsoft')) ? 'Microsoft 365'
    : mxHosts.some((h) => h.includes('zoho')) ? 'Zoho Mail'
      : mxHosts.length > 0 ? mxHosts[0] : 'none';

const spf = await resolveSpf(domain);
const detected = detectProviders(spf);
const dmarcRecords = (await txt(`_dmarc.${domain}`)).filter((r) => r.toLowerCase().startsWith('v=dmarc1'));
const dkimRecords = await txt(`${selector}._domainkey.${domain}`);
const dkimPublished = dkimRecords.some((r) => /p=[A-Za-z0-9+/=]{20,}/.test(r));

console.log(bold('Current state'));
console.log(`  Inbound mail (MX) : ${inboundProvider}`);
console.log(`  SPF senders       : ${detected.length ? detected.join(', ') : 'none detected'}`);
console.log(`  SPF lookups       : ${spf.lookups} of ${MAX_LOOKUPS}`);
console.log(`  DMARC records     : ${dmarcRecords.length}`);
console.log(`  DKIM (${selector})${' '.repeat(Math.max(0, 8 - selector.length))}: ${dkimPublished ? 'published' : 'not published'}\n`);

const changes = [];

// --- 1. SPF ----------------------------------------------------------------

console.log(bold('1. SPF'));

const authorises = Boolean(required)
  && spf.includes.some((include) => include.toLowerCase() === required.toLowerCase());

if (!required) {
  console.log(yellow('   Unknown provider - cannot determine the required include.'));
} else if (!spf.found) {
  console.log(red('   No SPF record at all.'));
  changes.push({ action: 'ADD', type: 'TXT', name: '@', value: `v=spf1 include:${required} ~all` });
} else if (authorises) {
  console.log(green(`   ${provider.label} is already authorised. No change needed.`));
} else {
  const existing = spf.rootIncludes.map((i) => `include:${i}`).join(' ');
  const all = spf.allMechanism ?? '~';

  console.log(`   Current: ${dim(spf.root)}`);
  console.log(yellow(`   ${provider.label} is not authorised yet. Add the include - do NOT replace the record.`));
  if (detected.length > 0) {
    console.log(yellow(`   The existing record covers ${detected.join(', ')}. Removing it breaks that mail.`));
  }

  changes.push({
    action: 'REPLACE',
    type: 'TXT',
    name: '@',
    before: spf.root,
    value: `v=spf1 ${existing} include:${required} ${all}all`,
    note: `${spf.lookups + 1} of ${MAX_LOOKUPS} DNS lookups after this change`,
  });
}

// --- 2. DKIM ---------------------------------------------------------------

console.log(`\n${bold('2. DKIM')}`);

if (dkimPublished) {
  console.log(green(`   ${selector}._domainkey.${domain} is published.`));
} else {
  console.log(yellow('   Not published yet. This one cannot be pre-written - the provider generates the key.'));
  console.log(dim(`   Enable DKIM in the ${provider.label} admin console and publish the TXT record it shows.`));
  changes.push({
    action: 'ADD',
    type: 'TXT',
    name: `${selector}._domainkey`,
    value: '<the value your provider generates>',
    note: 'Each provider uses its own selector, so several can coexist',
  });
}

// --- 3. DMARC --------------------------------------------------------------

console.log(`\n${bold('3. DMARC')}`);

if (dmarcRecords.length === 0) {
  console.log(yellow('   No DMARC record.'));
  changes.push({
    action: 'ADD', type: 'TXT', name: '_dmarc',
    value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
  });
} else if (dmarcRecords.length > 1) {
  // RFC 7489: more than one record means receivers ignore DMARC for the
  // domain entirely, so it is unprotected despite looking configured.
  console.log(red(`   ${dmarcRecords.length} DMARC records found. This is a fault.`));
  console.log(red('   When a receiver finds more than one it ignores DMARC for the domain'));
  console.log(red('   completely - so this domain effectively has no DMARC policy today.'));
  dmarcRecords.forEach((r) => console.log(dim(`     ${r}`)));

  // Merge: keep every reporting address and the strictest policy present.
  const ruas = [...new Set(
    dmarcRecords
      .flatMap((r) => (r.match(/rua=([^;]+)/i)?.[1] ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )];
  const policies = dmarcRecords
    .map((r) => r.match(/\bp=(none|quarantine|reject)\b/i)?.[1]?.toLowerCase())
    .filter(Boolean);
  const strongest = policies.includes('reject') ? 'reject'
    : policies.includes('quarantine') ? 'quarantine' : 'none';

  changes.push({
    action: 'REPLACE', type: 'TXT', name: '_dmarc',
    before: `${dmarcRecords.length} separate records`,
    value: `v=DMARC1; p=${strongest}; rua=${ruas.join(',')}`,
    note: 'Merged into one record, keeping every reporting address',
  });
} else {
  const policy = dmarcRecords[0].match(/\bp=(none|quarantine|reject)\b/i)?.[1] ?? '?';
  console.log(green(`   One record, p=${policy}.`));
  if (policy === 'none') {
    console.log(dim('   p=none only monitors. Once reports look clean, move to quarantine then reject.'));
  }
}

// --- Summary ---------------------------------------------------------------

console.log(`\n${bold('Changes to publish')}\n`);

if (changes.length === 0) {
  console.log(green('  Nothing to change - the domain is ready.\n'));
} else {
  changes.forEach((change, index) => {
    console.log(`  ${bold(`${index + 1}. ${change.action} ${change.type} record`)}`);
    console.log(`     Name  : ${change.name}`);
    if (change.before) console.log(`     Was   : ${dim(change.before)}`);
    console.log(`     Value : ${green(change.value)}`);
    if (change.note) console.log(`     Note  : ${dim(change.note)}`);
    console.log('');
  });
}

if (provider.bulkPolicyNote) {
  console.log(dim(`  ${provider.bulkPolicyNote}`));
  console.log(dim(`  ${provider.dailyLimitNote}\n`));
}

console.log(dim('  Nothing was modified. Re-run `npm run check:dns` once these are live.\n'));
