import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, pacingDefaults, buildWarmupSchedule, resolveProvider,
} from '../src/config/providers.js';

/**
 * The pacing numbers have to agree with each other. An hourly cap that
 * cannot reach the daily cap, or a send interval too slow to clear the
 * queue, produces a service that quietly never finishes a campaign.
 */

const WINDOW_HOURS = 10;

for (const [name, provider] of Object.entries(PROVIDERS)) {
  test(`${name}: pacing defaults are internally consistent`, () => {
    const p = pacingDefaults(provider);

    assert.ok(p.dailyCap > 0, 'daily cap must be positive');

    // The hourly cap, sustained across the window, must be able to reach the
    // daily cap - otherwise the daily figure is unreachable fiction.
    assert.ok(p.hourlyCap * WINDOW_HOURS >= p.dailyCap,
      `hourly ${p.hourlyCap} x ${WINDOW_HOURS}h cannot reach daily ${p.dailyCap}`);

    // The send interval must likewise allow the daily cap inside the window.
    const capacity = (WINDOW_HOURS * 3600) / p.minIntervalSeconds;
    assert.ok(capacity >= p.dailyCap,
      `interval ${p.minIntervalSeconds}s allows only ${Math.floor(capacity)}/day, under the cap of ${p.dailyCap}`);

    // No single receiving domain should absorb a whole hour's volume.
    assert.ok(p.perDomainHourlyCap < p.hourlyCap || p.hourlyCap <= 10,
      'per-domain cap should be a fraction of the hourly cap');
  });

  test(`${name}: recommended cap stays under the provider ceiling`, () => {
    if (!provider.dailyLimit) return; // no published ceiling to compare against

    assert.ok(provider.recommendedDailyCap < provider.dailyLimit,
      `recommended ${provider.recommendedDailyCap} must leave headroom under ${provider.dailyLimit}`);

    // Ordinary human email from the same mailbox counts against the same
    // quota, so the gap needs to be meaningful rather than token.
    const headroom = 1 - provider.recommendedDailyCap / provider.dailyLimit;
    assert.ok(headroom >= 0.25,
      `only ${Math.round(headroom * 100)}% headroom under the ceiling - too tight`);
  });
}

test('warm-up ramp starts low, rises monotonically and lands on the target', () => {
  const schedule = buildWarmupSchedule(1200);

  assert.ok(schedule[0] <= 25, `should start cold, began at ${schedule[0]}`);
  assert.equal(schedule.at(-1), 1200, 'must finish exactly at the target');

  for (let i = 1; i < schedule.length; i += 1) {
    assert.ok(schedule[i] > schedule[i - 1],
      `ramp must only increase: ${schedule[i - 1]} -> ${schedule[i]} at day ${i + 1}`);
  }

  // Receivers react to the rate of change, so no single day should be a
  // large multiple of the one before it.
  for (let i = 1; i < schedule.length; i += 1) {
    const ratio = schedule[i] / schedule[i - 1];
    assert.ok(ratio <= 2, `day ${i + 1} jumps ${ratio.toFixed(1)}x, too steep`);
  }

  assert.ok(schedule.length >= 10 && schedule.length <= 30,
    `ramp should take a few weeks, got ${schedule.length} days`);
});

test('warm-up terminates even for an absurd target', () => {
  const schedule = buildWarmupSchedule(10_000_000);
  assert.ok(schedule.length <= 61, 'must not loop unbounded');
  assert.equal(schedule.at(-1), 10_000_000);
});

test('a target below the starting volume still produces a usable ramp', () => {
  const schedule = buildWarmupSchedule(10);
  assert.deepEqual(schedule, [10], 'nothing to ramp through, so go straight there');
});


/**
 * Zoho's regional data centres.
 *
 * The SPF include has to match the data centre the account lives in -
 * `include:zoho.in` for India, `include:zoho.com` for global. Resolving the
 * wrong one produces a DNS record that reads correctly and authenticates
 * nothing, so every message fails SPF with no obvious cause.
 */
test('zoho region is detected from the paid host as well as the free one', () => {
  for (const host of ['smtp.zoho.in', 'smtppro.zoho.in', 'imappro.zoho.in']) {
    const preset = resolveProvider('zoho', host);
    assert.equal(preset.region, 'in', `${host} should resolve to the India data centre`);
    assert.equal(preset.spfInclude, 'zoho.in', `${host} must authorise the India include`);
  }
});

test('an explicitly chosen region beats whatever the host looks like', () => {
  // The operator picks the data centre in the UI; a hand-typed host must not
  // silently override it.
  const preset = resolveProvider('zoho', 'smtp.example.invalid', 'eu');
  assert.equal(preset.region, 'eu');
  assert.equal(preset.spfInclude, 'zoho.eu');
  assert.equal(preset.smtpHost, 'smtppro.zoho.eu');
});

test('an unknown region falls back to the global preset rather than inventing one', () => {
  const preset = resolveProvider('zoho', 'smtppro.zoho.nowhere');
  assert.equal(preset.spfInclude, 'zoho.com');
});

test('the zoho preset targets the paid custom-domain hosts', () => {
  // This service sends from a custom domain, which on Zoho is a paid
  // organisation account - those use the `pro` hosts.
  assert.match(PROVIDERS.zoho.smtpHost, /^smtppro\./);
  assert.match(PROVIDERS.zoho.imapHost, /^imappro\./);
});
