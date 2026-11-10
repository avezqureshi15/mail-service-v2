import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSpf, checkDmarc } from '../src/lib/dns-check.js';
import { GREETING } from '../src/lib/smtp-probe.js';
import { zohoRegionMismatch } from '../src/lib/spf.js';
import { PROVIDERS, resolveProvider } from '../src/config/providers.js';

// Zoho India, as resolved from a configured smtp.zoho.in host.
const ZOHO_IN = resolveProvider('zoho', 'smtp.zoho.in');

/**
 * The checks that guard against silent failures - records that read as
 * correct but authenticate nothing.
 */

test('a Zoho include for the wrong data centre is flagged, not passed', () => {
  // The failure this guards against: SMTP_HOST is smtp.zoho.in while SPF
  // authorises zoho.com. The record reads as correct and every message
  // still fails SPF, with nothing in the record to explain why.
  const spf = { includes: ['zoho.com'] };

  const mismatch = zohoRegionMismatch(spf, 'in');
  assert.ok(mismatch, 'a wrong-region include must be reported');
  assert.deepEqual(mismatch.authorised, ['zoho.com']);
  assert.equal(mismatch.expected, 'zoho.in');

  // The matching region is fine, in either case.
  assert.equal(zohoRegionMismatch({ includes: ['zoho.in'] }, 'in'), null);
  assert.equal(zohoRegionMismatch({ includes: ['ZOHO.IN'] }, 'in'), null);

  // Multiple regions are fine as long as the one in use is among them.
  assert.equal(zohoRegionMismatch({ includes: ['zoho.com', 'zoho.in'] }, 'in'), null);

  // No Zoho include at all is a different failure, handled elsewhere.
  assert.equal(zohoRegionMismatch({ includes: ['_spf.google.com'] }, 'in'), null);

  // Unknown data centre cannot be checked, so it must not false-positive.
  assert.equal(zohoRegionMismatch({ includes: ['zoho.com'] }, null), null);
});

test('SPF is checked against the configured provider, not any provider', async () => {
  // google.com authorises Google but never Zoho. Which answer is correct
  // depends entirely on who you are sending through.
  const asZoho = await checkSpf('google.com', { provider: PROVIDERS.zoho });
  assert.equal(asZoho.ok, false);
  assert.match(asZoho.summary, /does not authorise Zoho Mail/);
  assert.match(asZoho.detail, /include:zoho\.com/);

  const asGoogle = await checkSpf('google.com', { provider: PROVIDERS.google });
  assert.equal(asGoogle.ok, true, 'Google is authorised on its own domain');
});

test('webknot.in authenticates for Google but not for Zoho', async () => {
  // The same record, two verdicts - this is why the check has to know the
  // provider rather than looking for any recognisable include.
  const asGoogle = await checkSpf('webknot.in', { provider: PROVIDERS.google });
  assert.equal(asGoogle.ok, true);
  assert.match(asGoogle.summary, /authorises Google/);

  const asZoho = await checkSpf('webknot.in', { provider: PROVIDERS.zoho });
  assert.equal(asZoho.ok, false);
  assert.match(asZoho.detail, /do not replace it/);
});

test('SPF check finds a provider nested below the root record', async () => {
  // webknot.in authorises Google one level down, behind a management
  // include. The advice must preserve that include rather than replace it.
  const result = await checkSpf('webknot.in', { provider: ZOHO_IN });
  assert.equal(result.ok, false, 'Zoho is not authorised on this domain yet');
  assert.match(result.detail, /do not replace it/);
  // The merged record it suggests must keep the existing include...
  assert.match(result.detail, /include:dc-aa8e722993\._spfm\.webknot\.in/);
  // ...add the right region...
  assert.match(result.detail, /include:zoho\.in/);
  // ...and not re-state the nested Google include, which would waste a lookup.
  const suggested = result.detail.split('\n').find((l) => l.trim().startsWith('v=spf1'));
  assert.ok(!suggested.includes('_spf.google.com'),
    `nested include must not be hoisted into the root record: ${suggested}`);
  // It should still tell the operator Google is in play.
  assert.match(result.detail, /Also authorised: google/);
});

test('duplicate DMARC records are reported as a fault', async () => {
  // webknot.in currently publishes two. Receivers ignore DMARC entirely when
  // that happens, so it must not be reported as merely "present".
  const result = await checkDmarc('webknot.in');
  assert.equal(result.ok, false);
  assert.match(result.summary, /must be exactly one/);
});

test('a domain with no SPF is reported with a usable record to add', async () => {
  const result = await checkSpf('no-such-domain-xyz-99812.invalid', { provider: ZOHO_IN });
  assert.equal(result.ok, false);
  assert.match(result.summary, /No SPF record/);
  assert.match(result.detail, /include:zoho\.in/);
});

test('greeting patterns match the right protocol', () => {
  assert.ok(GREETING.smtp.test('220 smtp.zoho.in SMTP Server ready'));
  assert.ok(GREETING.imap.test('* OK svwall.zoho.com IMAP4 Server'));
  // An IMAP greeting must not be accepted as a healthy SMTP one, or a
  // misconfigured port would look fine.
  assert.ok(!GREETING.smtp.test('* OK IMAP4 Server'));
  assert.ok(!GREETING.imap.test('220 SMTP Server ready'));
  // 554 is a server refusing the connection, not a greeting.
  assert.ok(!GREETING.smtp.test('554 no SMTP service here'));
});
