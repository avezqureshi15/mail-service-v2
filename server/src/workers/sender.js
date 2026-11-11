import { getSettings, currentDailyAllowance as globalAllowance } from '../db/repositories/settings.js';
import { activeMailboxes, getMailbox } from '../db/repositories/mailboxes.js';
import { currentDailyAllowance, warmupStage } from '../lib/warmup.js';
import { createSenderLoop } from './sender-loop.js';
import { checkDomain } from '../lib/dns-check.js';
import { recordDomainHealth } from '../db/repositories/domain-health.js';
import {
  releaseStaleLocks, domainsOverHourlyCap, recentDeliveryHealth,
  sentToday, sentInLastHour,
} from '../db/repositories/jobs.js';
import { execute } from '../db/index.js';

/**
 * Supervises one sending loop per active mailbox.
 *
 * The loops do the sending; this module does the two things they must not
 * each do for themselves.
 *
 * It starts loops. It never stops them - a loop re-reads its own mailbox
 * every tick and terminates itself when that mailbox is gone, deactivated or
 * paused, so there is no window in which a supervisor tears down a loop that
 * is mid-send.
 *
 * And it runs the janitor: the measurements that belong to the system rather
 * than to any one account. Three of them, each here for its own reason. The
 * stale-lock sweep is one global statement, so N loops issuing it every tick
 * would be pure write amplification and would have them blocking on each
 * other's row locks. The bounce-rate circuit breaker is a property of the
 * domain's reputation, and `rateCheckMinimumSends` already concedes that
 * per-mailbox readings are noise at these volumes. And the per-receiving-
 * domain burst cap *must* be global: a receiver attributes traffic from all
 * our mailboxes on one sending domain to one sender, so three mailboxes each
 * measuring their own 25/hour would quietly deliver 75 and defeat the gate.
 */

const JANITOR_MS = 30_000;
const STALE_LOCK_MINUTES = 15;
const DOMAIN_AUTH_TTL_MS = 60 * 60_000;

const log = (...args) => console.log('[sender]', ...args);

/** mailboxId -> loop */
const loops = new Map();

let janitor = null;
let supervising = false;

// Janitor measurements, read synchronously by every loop.
let blockedDomains = [];
let deliveryHealth = { ok: true };
/** `${domain}:${selector}` -> { ok, detail, checkedAt } */
const domainAuth = new Map();

const shared = {
  blockedDomains: () => blockedDomains,
  deliveryHealth: () => deliveryHealth,
  domainAuth: (domain, selector) => {
    const cached = domainAuth.get(`${domain}:${selector}`);
    // Nothing measured yet: allow sending rather than stalling every loop on
    // the first tick after a restart. The janitor fills this immediately.
    if (!cached) return { ok: true, detail: null };
    return cached;
  },
};

/**
 * Pauses every sending campaign. Reserved for the bounce/complaint breaker,
 * which is a domain-wide problem - a provider quota error pauses only the one
 * mailbox that hit it, in sender-loop.js.
 */
function pauseAllSending(reason) {
  return execute(
    `UPDATE campaigns SET status = 'paused', pause_reason = $1, updated_at = now()
      WHERE status = 'sending'`,
    [reason],
  );
}

/**
 * Re-checks SPF/DKIM/DMARC once per distinct (domain, selector) in use.
 *
 * The pair, not the domain: a Google mailbox publishes DKIM under selector
 * `google` and needs include:_spf.google.com, while a Zoho mailbox on the
 * same domain wants `zoho` and include:zoho.com. One result per domain would
 * let whichever checked last decide whether the other could send.
 */
async function refreshDomainAuth(settings) {
  if (!settings.requireDomainAuth) {
    domainAuth.clear();
    return;
  }

  const pairs = new Map();
  for (const mailbox of activeMailboxes()) {
    pairs.set(`${mailbox.sending_domain}:${mailbox.dkim_selector}`, mailbox);
  }

  for (const [key, mailbox] of pairs) {
    const cached = domainAuth.get(key);
    if (cached && Date.now() - cached.checkedAt < DOMAIN_AUTH_TTL_MS) continue;

    try {
      const result = await checkDomain(mailbox.sending_domain, mailbox.dkim_selector, {
        provider: mailbox.preset,
      });
      domainAuth.set(key, {
        ok: result.passing,
        detail: `SPF: ${result.spf.summary}; DKIM: ${result.dkim.summary}`,
        checkedAt: Date.now(),
      });
      await recordDomainHealth(mailbox.sending_domain, mailbox.dkim_selector, result);
    } catch (error) {
      // A DNS outage must not silently unblock sending.
      domainAuth.set(key, {
        ok: false,
        detail: `Domain check failed: ${error.message}`,
        checkedAt: Date.now(),
      });
    }
  }
}

async function runJanitor() {
  const settings = getSettings();

  try {
    await releaseStaleLocks(STALE_LOCK_MINUTES);

    blockedDomains = await domainsOverHourlyCap(settings.perDomainHourlyCap);

    const health = await recentDeliveryHealth(24);
    if (health.sent < settings.rateCheckMinimumSends) {
      deliveryHealth = { ok: true };
    } else if (health.complaintRate > settings.maxComplaintRatePercent) {
      deliveryHealth = {
        ok: false,
        reason: `complaint rate ${health.complaintRate}% exceeds ${settings.maxComplaintRatePercent}%`,
      };
    } else if (health.bounceRate > settings.maxBounceRatePercent) {
      deliveryHealth = {
        ok: false,
        reason: `bounce rate ${health.bounceRate}% exceeds ${settings.maxBounceRatePercent}%`,
      };
    } else {
      deliveryHealth = { ok: true };
    }

    if (!deliveryHealth.ok) {
      const paused = await pauseAllSending(`Auto-paused: ${deliveryHealth.reason}`);
      if (paused > 0) log(`AUTO-PAUSED ${paused} campaign(s) - ${deliveryHealth.reason}`);
    }

    await refreshDomainAuth(settings);
  } catch (error) {
    console.error('[sender] janitor failed', error);
  }

  reconcile();
}

/** Starts a loop for any active mailbox that does not have one running. */
function reconcile() {
  if (!supervising) return;

  for (const mailbox of activeMailboxes()) {
    const existing = loops.get(mailbox.id);
    if (existing?.isRunning()) continue;

    const loop = existing ?? createSenderLoop(mailbox.id, shared);
    loops.set(mailbox.id, loop);
    loop.start();
    log(`loop started for "${mailbox.label}" <${mailbox.from_email}>`);
  }

  // Drop handles for loops that stopped themselves and whose mailbox is no
  // longer active, so the map does not grow forever.
  for (const [id, loop] of loops) {
    if (loop.isRunning()) continue;
    const mailbox = getMailbox(id);
    if (!mailbox || !mailbox.is_active) loops.delete(id);
  }
}

export function startSender() {
  if (supervising) return;
  supervising = true;

  const count = activeMailboxes().length;
  log(count === 0
    ? 'supervisor started - no active mailboxes yet'
    : `supervisor started - ${count} mailbox(es)`);

  reconcile();
  janitor = setInterval(runJanitor, JANITOR_MS);
  janitor.unref?.();
  // One pass immediately, so the first loops are not running for 30s with no
  // blocked-domain list and no domain-auth result.
  runJanitor();
}

export function stopSender() {
  supervising = false;
  if (janitor) clearInterval(janitor);
  janitor = null;
  for (const loop of loops.values()) loop.stop();
}

/**
 * Waits for any send already on the wire, so shutdown does not exit
 * underneath one. Bounded, because a hung socket must not block the exit.
 */
export async function drainSender(timeoutMs = 8000) {
  const idle = Promise.all([...loops.values()].map((l) => l.whenIdle()));
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([idle, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Mailbox ids with a live loop. Exported for tests and the status endpoints. */
export function runningLoops() {
  return [...loops.values()].filter((l) => l.isRunning()).map((l) => l.mailboxId);
}

function sendWindowState(settings, now = new Date()) {
  const day = now.getDay();
  if (!settings.sendOnWeekends && (day === 0 || day === 6)) {
    return { ok: false, reason: 'outside sending days (weekend)' };
  }
  const hour = now.getHours();
  if (hour < settings.sendWindowStartHour || hour >= settings.sendWindowEndHour) {
    return {
      ok: false,
      reason: `outside sending window (${settings.sendWindowStartHour}:00-${settings.sendWindowEndHour}:00)`,
    };
  }
  return { ok: true };
}

/**
 * Why one mailbox is or is not sending. Consumed by the campaign page, which
 * would otherwise show work queued and nothing happening, with no way to tell
 * that the send window simply closed for the evening.
 *
 * Called with no mailbox it reports the system-wide view instead, which is
 * what the dashboard wants.
 */
export async function senderStatus(mailboxId = null) {
  const settings = getSettings();
  const mailbox = mailboxId ? getMailbox(mailboxId) : null;
  const window = sendWindowState(settings);

  if (!mailbox) {
    const [today, lastHour] = await Promise.all([sentToday(), sentInLastHour()]);

    // The dashboard banner asks one question - is anything blocked? - so the
    // system view reports the worst answer across every (domain, selector)
    // pair in use, and names the pairs that are failing.
    const failing = [...domainAuth.entries()].filter(([, v]) => !v.ok);
    const measured = domainAuth.size > 0;

    // The daily figure across every sender, since there is no longer a
    // single mailbox whose allowance would be the answer.
    const totalAllowance = activeMailboxes()
      .reduce((sum, m) => sum + currentDailyAllowance(m.pacing), 0);

    return {
      running: supervising,
      mailboxes: runningLoops().length,
      withinSendWindow: window.ok,
      windowReason: window.reason ?? null,
      sentToday: today,
      sentLastHour: lastHour,
      dailyAllowance: totalAllowance || globalAllowance(settings),
      remainingToday: Math.max(0, (totalAllowance || globalAllowance(settings)) - today),
      hourlyCap: settings.hourlyCap,
      throttledDomains: blockedDomains,
      deliveryHealth,
      domainAuth: {
        enforced: settings.requireDomainAuth,
        // null until the janitor has measured anything, so the UI can tell
        // "not checked yet" from "checked and failing".
        passing: measured ? failing.length === 0 : null,
        detail: failing.length > 0
          ? failing.map(([key, v]) => `${key}: ${v.detail}`).join(' | ')
          : null,
      },
    };
  }

  const loop = loops.get(mailbox.id);
  const { pacing } = mailbox;
  const allowance = currentDailyAllowance(pacing);

  const [today, lastHour] = await Promise.all([
    sentToday(mailbox.id),
    sentInLastHour(mailbox.id),
  ]);

  const auth = shared.domainAuth(mailbox.sending_domain, mailbox.dkim_selector);

  return {
    mailboxId: mailbox.id,
    mailboxLabel: mailbox.label,
    fromEmail: mailbox.from_email,
    running: Boolean(loop?.isRunning()),
    pausedUntil: mailbox.paused_until ?? null,
    pauseReason: mailbox.pause_reason ?? null,
    withinSendWindow: window.ok,
    windowReason: window.reason ?? null,
    reason: loop?.reason() ?? null,
    sentToday: today,
    dailyAllowance: allowance,
    remainingToday: Math.max(0, allowance - today),
    sentLastHour: lastHour,
    hourlyCap: pacing.hourlyCap,
    warmup: warmupStage(pacing),
    throttledDomains: blockedDomains,
    domainAuth: {
      enforced: settings.requireDomainAuth,
      passing: auth.ok,
      detail: auth.detail,
    },
  };
}

/** One entry per active mailbox, for the dashboard. */
export function allSenderStatus() {
  return Promise.all(activeMailboxes().map((mailbox) => senderStatus(mailbox.id)));
}
