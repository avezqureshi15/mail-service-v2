/**
 * Warm-up ramp arithmetic, as pure functions over an explicit config.
 *
 * This used to live in the settings repository and read the one global
 * settings object. Now that every mailbox ramps on its own schedule, neither
 * the settings repository nor the mailbox repository should own it - both
 * call in here with their own numbers, and it stays trivially testable
 * without a database.
 */

/** Normalises a DATE column (which `pg` hands back as a Date) to YYYY-MM-DD. */
export function asDayString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * Today's allowance for one sender.
 *
 * During warm-up this is the ramp value for the current day, which is lower
 * than the ceiling - whichever is smaller wins, so raising the cap mid-ramp
 * does not jump the volume.
 *
 * @param {object} config
 * @param {number} config.dailyCap          Ceiling once warm-up has completed.
 * @param {boolean} config.warmupEnabled
 * @param {string|Date|null} config.warmupStartedOn  Day 1 of the ramp.
 * @param {number[]} config.warmupSchedule   Sends/day, index 0 is day 1.
 */
export function currentDailyAllowance({
  dailyCap,
  warmupEnabled,
  warmupStartedOn,
  warmupSchedule,
}) {
  if (!warmupEnabled || !warmupStartedOn) return dailyCap;

  const day = asDayString(warmupStartedOn);
  if (!day) return dailyCap;

  const started = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(started.getTime())) return dailyCap;

  const dayIndex = Math.floor((Date.now() - started.getTime()) / 86_400_000);
  // A ramp dated in the future means nothing may go out yet.
  if (dayIndex < 0) return 0;

  const schedule = warmupSchedule ?? [];
  if (dayIndex >= schedule.length) return dailyCap;

  return Math.min(schedule[dayIndex], dailyCap);
}

/** The same figure, with the surrounding detail the UI shows. */
export function warmupStage(config) {
  const { dailyCap, warmupEnabled, warmupStartedOn } = config;

  if (!warmupEnabled || !warmupStartedOn) {
    return { active: false, day: null, totalDays: 0, allowance: dailyCap };
  }

  const day = asDayString(warmupStartedOn);
  const started = new Date(`${day}T00:00:00Z`);
  const dayIndex = Math.floor((Date.now() - started.getTime()) / 86_400_000);
  const totalDays = (config.warmupSchedule ?? []).length;

  return {
    active: dayIndex < totalDays,
    day: dayIndex + 1,
    totalDays,
    allowance: currentDailyAllowance(config),
  };
}
