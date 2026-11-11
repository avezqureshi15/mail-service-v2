import { query, execute } from '../index.js';
import { env } from '../../config/env.js';
import { pacingDefaults } from '../../config/providers.js';
import {
  currentDailyAllowance as warmupAllowance,
  warmupStage as warmupStageFor,
} from '../../lib/warmup.js';

// Volume and pacing are derived from the configured provider's recommended
// cap, so the hourly figure and send interval can never silently contradict
// the daily one, and switching provider brings a coherent set with it.
const pacing = pacingDefaults(env.provider);

export const DEFAULT_SETTINGS = {
  // Ceiling once warm-up has completed. Deliberately below the provider's
  // hard limit, because ordinary human email from the same mailbox counts
  // against the same quota.
  dailyCap: pacing.dailyCap,
  // Upper bound per hour, spread across the sending window.
  hourlyCap: pacing.hourlyCap,
  // Base gap between sends, jittered by +/- jitterPercent so the pattern is
  // not metronomic.
  minIntervalSeconds: pacing.minIntervalSeconds,
  jitterPercent: 60,
  // No more than this many messages to one receiving domain per hour. Sending
  // 200 gmail.com addresses inside a minute is a classic bulk signature.
  perDomainHourlyCap: pacing.perDomainHourlyCap,
  // Local-time sending window. Cold outreach landing at 03:00 looks automated.
  sendWindowStartHour: 8,
  sendWindowEndHour: 18,
  sendOnWeekends: false,
  // Warm-up ramp, in sends/day. Index 0 is day 1 of the domain's life.
  warmupEnabled: true,
  warmupStartedOn: null,
  warmupSchedule: pacing.warmupSchedule,
  // Auto-pause thresholds. Gmail and Yahoo expect complaints under 0.3%.
  maxBounceRatePercent: 5,
  maxComplaintRatePercent: 0.3,
  // Minimum sends before the rates above are meaningful.
  rateCheckMinimumSends: 50,
  // Consecutive soft bounces before an address is suppressed.
  softBounceLimit: 4,
  maxSendAttempts: 3,
  // Block sending while SPF or DKIM is failing. The single most effective
  // guard in the system - turning it off defeats the purpose of the service.
  requireDomainAuth: true,
  // Exclude info@/sales@/support@ style addresses by default.
  excludeRoleAccounts: true,
  // TESTING ONLY. Reinterprets a step's wait as minutes instead of days, so
  // a three-day follow-up fires three minutes later and a sequence can be
  // exercised end to end in one sitting. Left on with live contacts it would
  // send an entire sequence within the hour, so the UI warns about it
  // wherever it can.
  sequenceWaitUnit: 'days',
};

/**
 * Settings are read on nearly every worker tick, so they are cached in memory
 * and the cache dropped whenever they are written. Going to the database for
 * seventeen small rows several times a second would be wasteful now that it
 * is a network round trip rather than a local file read.
 */
let cache = null;

export function invalidateSettingsCache() {
  cache = null;
}

/** Loads settings from the database and refreshes the cache. */
export async function loadSettings() {
  const stored = await query('SELECT key, value FROM settings');
  const result = { ...DEFAULT_SETTINGS };
  for (const { key, value } of stored) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    try {
      result[key] = JSON.parse(value);
    } catch {
      // Keep the default if a row was hand-edited into something unparseable.
    }
  }
  cache = result;
  return result;
}

/**
 * The settings as last loaded. Synchronous so the hot paths - the sender
 * tick, every scheduling decision - do not each await a round trip.
 * `loadSettings()` runs at startup and after every write.
 */
export function getSettings() {
  return cache ?? { ...DEFAULT_SETTINGS };
}

export function getSetting(key) {
  return getSettings()[key];
}

export async function setSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    await execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value)],
    );
  }
  return loadSettings();
}

/**
 * Today's allowance for the global settings.
 *
 * The arithmetic itself lives in lib/warmup.js, because each mailbox now
 * ramps on its own schedule and both this module and the mailbox repository
 * need the same answer. These two wrappers keep the existing callers working
 * while there is only one implementation to get right.
 */
export function currentDailyAllowance(settings = getSettings()) {
  return warmupAllowance(settings);
}

export function warmupStage(settings = getSettings()) {
  return warmupStageFor(settings);
}
