/**
 * Is a set of pacing numbers actually deliverable?
 *
 * Lifted out of the settings route, because the numbers now live in two
 * places: the caps belong to a mailbox, the sending window stays global. Both
 * routes have to run the same check, and a silently unreachable combination
 * is worse than a rejected change - the campaign simply never finishes and
 * nothing on the page explains why.
 */

export function checkAchievable({
  dailyCap,
  hourlyCap,
  minIntervalSeconds,
  windowHours,
}) {
  const hours = Math.max(1, windowHours);

  const byHour = hourlyCap * hours;
  const byInterval = Math.floor((hours * 3600) / minIntervalSeconds);
  const reachable = Math.min(byHour, byInterval);

  if (dailyCap <= reachable) return { ok: true, reachable };

  return {
    ok: false,
    reachable,
    error: `A daily cap of ${dailyCap} is unreachable with these limits - at most `
      + `${reachable} can be sent in the ${hours}h window.`,
    detail: `Raise the hourly cap (currently ${hourlyCap}/h) or shorten the send interval `
      + `(currently ${minIntervalSeconds}s), or widen the sending window.`,
  };
}

/**
 * A cap above what the provider allows does not raise throughput - it runs
 * the account into a sending suspension partway through a campaign.
 */
export function checkProviderCeiling(dailyCap, preset) {
  const limit = preset?.dailyLimit;
  if (!limit || !dailyCap || dailyCap <= limit) return { ok: true };

  return {
    ok: false,
    error: `Daily cap of ${dailyCap} exceeds what ${preset.label} allows (~${limit}/day).`,
    detail: preset.dailyLimitNote,
  };
}
