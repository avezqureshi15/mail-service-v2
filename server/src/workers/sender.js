import { env } from '../config/env.js';
import { getTransport } from '../mail/transport.js';
import { composeMessage } from '../mail/compose.js';
import { getSettings, currentDailyAllowance } from '../db/repositories/settings.js';
import {
  claimNextJob, markSent, markFailed, releaseStaleLocks, incrementSentToday,
  sentToday, sentInLastHour, domainsOverHourlyCap, hasPendingWork,
  recentDeliveryHealth, campaignJobStats,
} from '../db/repositories/jobs.js';
import {
  getCampaign, getStep, countSteps, setCampaignStatus, getEnrollment,
  advanceEnrollment, completeEnrollment, exitEnrollment,
} from '../db/repositories/campaigns.js';
import { checkDomain } from '../lib/dns-check.js';
import { queryOne, execute } from '../db/index.js';

/**
 * Drains the send queue under the pacing rules.
 *
 * Everything that protects the Zoho account and the domain reputation lives
 * here: the daily cap, the warm-up ramp, per-domain throttling, the sending
 * window, jitter between messages, and the bounce/complaint auto-pause.
 * A campaign cannot opt out of any of it - sequences go through the same
 * queue precisely so follow-ups cannot bypass the limits.
 */

const TICK_IDLE_MS = 15_000;

let running = false;
let timer = null;
let domainAuthCache = { checkedAt: 0, passing: false, detail: null };

const log = (...args) => console.log('[sender]', ...args);

/**
 * Domain authentication is re-checked hourly rather than per message. If SPF
 * or DKIM is failing, nothing is sent at all - unauthenticated bulk mail goes
 * to spam no matter how carefully it is paced.
 */
async function domainAuthOk(settings) {
  if (!settings.requireDomainAuth) return { ok: true };

  const ONE_HOUR = 3_600_000;
  if (Date.now() - domainAuthCache.checkedAt < ONE_HOUR) {
    return { ok: domainAuthCache.passing, detail: domainAuthCache.detail };
  }

  try {
    const result = await checkDomain(env.SENDING_DOMAIN, env.DKIM_SELECTOR, { provider: env.provider });
    domainAuthCache = {
      checkedAt: Date.now(),
      passing: result.passing,
      detail: `SPF: ${result.spf.summary}; DKIM: ${result.dkim.summary}`,
    };
    await execute(
      `INSERT INTO domain_health (id, spf_ok, dkim_ok, dmarc_ok, detail, checked_at)
       VALUES (1, $1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         spf_ok = excluded.spf_ok, dkim_ok = excluded.dkim_ok, dmarc_ok = excluded.dmarc_ok,
         detail = excluded.detail, checked_at = excluded.checked_at`,
      [result.spf.ok, result.dkim.ok, result.dmarc.ok, JSON.stringify(result)],
    );
    return { ok: result.passing, detail: domainAuthCache.detail };
  } catch (error) {
    // A DNS outage should not silently unblock sending.
    return { ok: false, detail: `Domain check failed: ${error.message}` };
  }
}

function withinSendWindow(settings, now = new Date()) {
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
 * Pauses every sending campaign when bounce or complaint rates spike. This is
 * the mechanism that stops one bad list burning the domain for everything
 * that comes after it.
 */
async function checkDeliveryHealth(settings) {
  const health = await recentDeliveryHealth(24);
  if (health.sent < settings.rateCheckMinimumSends) return { ok: true, health };

  if (health.complaintRate > settings.maxComplaintRatePercent) {
    return { ok: false, health, reason: `complaint rate ${health.complaintRate}% exceeds ${settings.maxComplaintRatePercent}%` };
  }
  if (health.bounceRate > settings.maxBounceRatePercent) {
    return { ok: false, health, reason: `bounce rate ${health.bounceRate}% exceeds ${settings.maxBounceRatePercent}%` };
  }
  return { ok: true, health };
}

/**
 * One statement rather than a select and a loop: when the auto-pause fires,
 * every sending campaign has to stop at the same instant. Pausing them one
 * round trip at a time would leave the later ones still claiming jobs while
 * the earlier ones are already stopped.
 */
function pauseAllSending(reason) {
  return execute(
    `UPDATE campaigns SET status = 'paused', pause_reason = $1, updated_at = now()
      WHERE status = 'sending'`,
    [reason],
  );
}

/** Base interval plus jitter, so the send pattern is not metronomic. */
function nextDelayMs(settings) {
  const base = settings.minIntervalSeconds * 1000;
  const spread = base * (settings.jitterPercent / 100);
  return Math.max(1000, Math.round(base - spread / 2 + Math.random() * spread));
}

/**
 * Marks a campaign complete once nothing is left to do. For a sequence that
 * means no queued jobs AND no enrollments still waiting on a later step.
 */
async function finaliseCampaignIfDone(campaignId) {
  const stats = await campaignJobStats(campaignId);
  if (stats.queued > 0 || stats.sending > 0) return;

  const pending = await queryOne(
    "SELECT COUNT(*) AS n FROM sequence_enrollments WHERE campaign_id = $1 AND status = 'active'",
    [campaignId],
  );
  if (pending.n > 0) return;

  await setCampaignStatus(campaignId, 'completed');
  log(`campaign ${campaignId} completed (${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped)`);
}

/**
 * After a successful send, schedule the contact's next sequence step - or
 * finish their enrollment if that was the last one.
 */
async function scheduleNextStep({ campaignId, contactId, stepNo, messageId }) {
  const enrollment = await getEnrollment(campaignId, contactId);
  if (!enrollment || enrollment.status !== 'active') return;

  const total = await countSteps(campaignId);
  if (stepNo >= total) {
    await completeEnrollment(campaignId, contactId);
    return;
  }

  const next = await getStep(campaignId, stepNo + 1);
  await advanceEnrollment({
    campaignId,
    contactId,
    stepNo,
    waitDays: next?.wait_days ?? 3,
    // Step 1's Message-ID becomes the thread anchor for every follow-up.
    threadMessageId: stepNo === 1 ? messageId : enrollment.thread_message_id,
  });
}

async function sendOne(job) {
  const campaign = await getCampaign(job.campaign_id, job.tenant_id);
  if (!campaign) {
    await markFailed(job.id, 'Campaign no longer exists', { maxAttempts: 1 });
    return false;
  }

  const step = await getStep(job.campaign_id, job.step_no);
  if (!step) {
    await markFailed(job.id, `Step ${job.step_no} is not defined`, { maxAttempts: 1 });
    return false;
  }

  const enrollment = await getEnrollment(job.campaign_id, job.contact_id);

  const { message, messageId } = composeMessage({
    campaign,
    step,
    contact: {
      id: job.contact_id,
      email: job.email,
      first_name: job.first_name,
      last_name: job.last_name,
      company: job.company,
      custom_fields: job.custom_fields,
    },
    threadMessageId: job.step_no > 1 ? enrollment?.thread_message_id ?? null : null,
  });

  try {
    await (await getTransport()).sendMail(message);
  } catch (error) {
    const settings = getSettings();
    const result = await markFailed(job.id, error.message, { maxAttempts: settings.maxSendAttempts });

    // Zoho's limit is dynamic. If it answers with a quota error, stop for the
    // day rather than hammering it into a suspension.
    if (/limit|quota|exceeded|too many|554|552|421/i.test(error.message)) {
      const paused = await pauseAllSending(`Provider rejected send: ${error.message.slice(0, 200)}`);
      log(`provider limit hit - paused ${paused} campaign(s): ${error.message}`);
    }

    // Once we have given up on a step, the contact's enrollment must be
    // closed too - otherwise it sits 'active' with nothing scheduled and the
    // campaign can never reach 'completed'.
    if (!result.retrying && campaign.is_sequence) {
      await exitEnrollment({ campaignId: job.campaign_id, contactId: job.contact_id, reason: 'stopped' });
    }

    log(`send failed for ${job.email}${result.retrying ? ` (retry ${result.attempts} in ${result.delayMinutes}m)` : ' (gave up)'}: ${error.message}`);
    return false;
  }

  await markSent(job.id, messageId);
  await incrementSentToday();

  if (campaign.is_sequence) {
    await scheduleNextStep({
      campaignId: job.campaign_id,
      contactId: job.contact_id,
      stepNo: job.step_no,
      messageId,
    });
  }

  log(`sent step ${job.step_no} to ${job.email}`);
  return true;
}

/**
 * One pass: decide whether sending is allowed right now, and if so send a
 * single message. Returns the delay before the next pass.
 */
async function tick() {
  const settings = getSettings();

  await releaseStaleLocks(15);

  // The cheapest question first: with nothing queued, the tick costs one
  // query rather than the half-dozen the checks below would run.
  if (!await hasPendingWork()) return TICK_IDLE_MS;

  const window = withinSendWindow(settings);
  if (!window.ok) return TICK_IDLE_MS * 4;

  const allowance = currentDailyAllowance(settings);
  if (await sentToday() >= allowance) return TICK_IDLE_MS * 4;

  if (await sentInLastHour() >= settings.hourlyCap) return TICK_IDLE_MS * 2;

  const health = await checkDeliveryHealth(settings);
  if (!health.ok) {
    const paused = await pauseAllSending(`Auto-paused: ${health.reason}`);
    log(`AUTO-PAUSED ${paused} campaign(s) - ${health.reason}`);
    return TICK_IDLE_MS * 4;
  }

  const auth = await domainAuthOk(settings);
  if (!auth.ok) {
    const paused = await pauseAllSending(`Domain authentication failing - ${auth.detail}`);
    if (paused > 0) log(`AUTO-PAUSED ${paused} campaign(s) - ${auth.detail}`);
    return TICK_IDLE_MS * 4;
  }

  const blocked = await domainsOverHourlyCap(settings.perDomainHourlyCap);
  const job = await claimNextJob(blocked);

  if (!job) return TICK_IDLE_MS;
  // A suppressed or inactive contact was skipped inside the claim; come
  // straight back for the next one rather than waiting out the interval.
  if (job.skipped) return 50;

  await sendOne(job);
  await finaliseCampaignIfDone(job.campaign_id);

  return nextDelayMs(settings);
}

async function loop() {
  if (!running) return;
  let delay = TICK_IDLE_MS;
  try {
    delay = await tick();
  } catch (error) {
    console.error('[sender] tick failed', error);
    delay = TICK_IDLE_MS;
  }
  if (running) timer = setTimeout(loop, delay);
}

export function startSender() {
  if (running) return;
  running = true;
  log('worker started');
  timer = setTimeout(loop, 1000);
}

export function stopSender() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Exported for the dashboard, so the UI can explain why nothing is sending.
export async function senderStatus() {
  const settings = getSettings();
  const window = withinSendWindow(settings);
  const allowance = currentDailyAllowance(settings);

  const [today, lastHour, throttledDomains] = await Promise.all([
    sentToday(),
    sentInLastHour(),
    domainsOverHourlyCap(settings.perDomainHourlyCap),
  ]);

  return {
    running,
    withinSendWindow: window.ok,
    windowReason: window.reason ?? null,
    sentToday: today,
    dailyAllowance: allowance,
    remainingToday: Math.max(0, allowance - today),
    sentLastHour: lastHour,
    hourlyCap: settings.hourlyCap,
    throttledDomains,
    domainAuth: {
      enforced: settings.requireDomainAuth,
      passing: domainAuthCache.checkedAt > 0 ? domainAuthCache.passing : null,
      detail: domainAuthCache.detail,
    },
  };
}
