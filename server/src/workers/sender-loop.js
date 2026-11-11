import { getSettings } from '../db/repositories/settings.js';
import { getMailbox, pauseMailbox } from '../db/repositories/mailboxes.js';
import { currentDailyAllowance } from '../lib/warmup.js';
import { getTransport } from '../mail/transport.js';
import { composeMessage } from '../mail/compose.js';
import {
  claimNextJob, markSent, markFailed, incrementSentToday,
  sentToday, sentInLastHour, hasPendingWork, campaignJobStats,
} from '../db/repositories/jobs.js';
import {
  getCampaign, getStep, countSteps, setCampaignStatus, getEnrollment,
  advanceEnrollment, completeEnrollment, exitEnrollment, pauseCampaignsForMailbox,
} from '../db/repositories/campaigns.js';
import { queryOne } from '../db/index.js';

/**
 * One sending loop, for one mailbox.
 *
 * Everything that protects a single sending account lives here: its daily
 * cap, its warm-up ramp, its send interval, and the quota pause that parks it
 * when the provider pushes back. The checks that belong to the whole system
 * rather than to one account - the sending window, the bounce-rate circuit
 * breaker, the per-receiving-domain burst cap - are measured once by the
 * supervisor's janitor and read from `shared`, because measuring them N times
 * a tick would be both wasteful and, for the domain cap, wrong.
 *
 * The loop terminates itself. It re-reads its mailbox at the top of every
 * tick and stops when that mailbox is gone, deactivated or paused, which
 * removes the entire class of races where a supervisor tears a loop down
 * while it is mid-send.
 */

const TICK_IDLE_MS = 15_000;

// A provider answering with a quota error parks the mailbox for this long.
// It expires on its own, where a paused campaign would need a human.
const QUOTA_PAUSE_MINUTES = 12 * 60;

// `421` is also a generic "service unavailable, try again" and the pattern
// below is deliberately broad, so one answer is not enough to act on.
// Two in a row is a limit; one is a blip.
const QUOTA_STRIKES = 2;
const QUOTA_PATTERN = /limit|quota|exceeded|too many|554|552|421/i;

export function createSenderLoop(mailboxId, shared) {
  const log = (...args) => console.log(`[sender:${mailboxId}]`, ...args);

  let running = false;
  let timer = null;
  let inFlight = null;
  let quotaStrikes = 0;
  let lastReason = null;

  /** Base interval plus jitter, so the send pattern is not metronomic. */
  function nextDelayMs(pacing) {
    const base = pacing.minIntervalSeconds * 1000;
    const spread = base * (pacing.jitterPercent / 100);
    return Math.max(1000, Math.round(base - spread / 2 + Math.random() * spread));
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

  async function sendOne(job, mailbox) {
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
      mailbox,
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
      await (await getTransport(mailbox)).sendMail(message);
    } catch (error) {
      const settings = getSettings();
      const result = await markFailed(job.id, error.message, { maxAttempts: settings.maxSendAttempts });

      if (QUOTA_PATTERN.test(error.message)) {
        quotaStrikes += 1;
        if (quotaStrikes >= QUOTA_STRIKES) {
          // Only THIS mailbox. A Zoho account answering 421 says nothing
          // about a Google one, and pausing every campaign because one
          // sender hit its ceiling is how a single busy account stops the
          // whole service.
          await pauseMailbox(mailboxId, {
            minutes: QUOTA_PAUSE_MINUTES,
            reason: `Provider rejected send: ${error.message.slice(0, 200)}`,
          });
          log(`provider limit hit twice - paused for ${QUOTA_PAUSE_MINUTES / 60}h: ${error.message}`);
        } else {
          log(`possible provider limit (strike ${quotaStrikes}/${QUOTA_STRIKES}): ${error.message}`);
        }
      } else {
        quotaStrikes = 0;
      }

      // Once we have given up on a step, the contact's enrollment must be
      // closed too - otherwise it sits 'active' with nothing scheduled and
      // the campaign can never reach 'completed'.
      if (!result.retrying && campaign.is_sequence) {
        await exitEnrollment({ campaignId: job.campaign_id, contactId: job.contact_id, reason: 'stopped' });
      }

      log(`send failed for ${job.email}${result.retrying ? ` (retry ${result.attempts} in ${result.delayMinutes}m)` : ' (gave up)'}: ${error.message}`);
      return false;
    }

    quotaStrikes = 0;
    await markSent(job.id, messageId);
    await incrementSentToday(mailboxId);

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
   * One pass: decide whether this mailbox may send right now, and if so send
   * a single message. Returns the delay before the next pass.
   */
  async function tick() {
    // Re-read every tick, so a mailbox deactivated or paused in the UI stops
    // this loop without the supervisor having to reach into it.
    const mailbox = getMailbox(mailboxId);
    if (!mailbox) {
      log('mailbox no longer exists - stopping');
      running = false;
      return TICK_IDLE_MS;
    }
    if (!mailbox.is_active) {
      log('mailbox deactivated - stopping');
      running = false;
      return TICK_IDLE_MS;
    }
    if (mailbox.paused_until && new Date(mailbox.paused_until).getTime() > Date.now()) {
      lastReason = mailbox.pause_reason;
      running = false;
      return TICK_IDLE_MS;
    }

    const settings = getSettings();
    const pacing = mailbox.pacing;

    // The cheapest question first: with nothing queued for this mailbox, the
    // tick costs one query rather than the half-dozen below.
    if (!await hasPendingWork(mailboxId)) { lastReason = null; return TICK_IDLE_MS; }

    const window = withinSendWindow(settings);
    if (!window.ok) { lastReason = window.reason; return TICK_IDLE_MS * 4; }

    const allowance = currentDailyAllowance(pacing);
    if (await sentToday(mailboxId) >= allowance) {
      lastReason = `daily allowance reached (${allowance})`;
      return TICK_IDLE_MS * 4;
    }

    if (await sentInLastHour(mailboxId) >= pacing.hourlyCap) {
      lastReason = `hourly cap reached (${pacing.hourlyCap})`;
      return TICK_IDLE_MS * 2;
    }

    // Measured once by the janitor for the whole system - a bounce rate is a
    // property of the domain's reputation, not of one account.
    const health = shared.deliveryHealth();
    if (!health.ok) { lastReason = health.reason; return TICK_IDLE_MS * 4; }

    // Per (domain, selector): a Google and a Zoho mailbox can share a sending
    // domain and still need different DKIM selectors and SPF includes, so one
    // failing must not block the other.
    const auth = shared.domainAuth(mailbox.sending_domain, mailbox.dkim_selector);
    if (!auth.ok) {
      const paused = await pauseCampaignsForMailbox(
        mailboxId,
        `Domain authentication failing - ${auth.detail}`,
      );
      if (paused > 0) log(`AUTO-PAUSED ${paused} campaign(s) - ${auth.detail}`);
      lastReason = auth.detail;
      return TICK_IDLE_MS * 4;
    }

    const job = await claimNextJob(shared.blockedDomains(), mailboxId);

    if (!job) { lastReason = null; return TICK_IDLE_MS; }
    // A suppressed or inactive contact was skipped inside the claim; come
    // straight back for the next one rather than waiting out the interval.
    if (job.skipped) return 50;

    lastReason = null;
    await sendOne(job, mailbox);
    await finaliseCampaignIfDone(job.campaign_id);

    return nextDelayMs(pacing);
  }

  async function loop() {
    if (!running) return;

    let delay = TICK_IDLE_MS;
    // Held so shutdown can wait for a send already on the wire rather than
    // exiting underneath it.
    inFlight = (async () => {
      try {
        return await tick();
      } catch (error) {
        console.error(`[sender:${mailboxId}] tick failed`, error);
        return TICK_IDLE_MS;
      }
    })();

    delay = await inFlight;
    inFlight = null;

    if (running) timer = setTimeout(loop, delay);
  }

  return {
    mailboxId,

    start() {
      if (running) return;
      running = true;
      quotaStrikes = 0;
      // Staggered, so N mailboxes do not all dial out in the same instant.
      timer = setTimeout(loop, 1000 + Math.random() * 2000);
    },

    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    isRunning: () => running,

    /** Resolves once any in-flight tick has finished. */
    whenIdle: () => inFlight ?? Promise.resolve(),

    reason: () => lastReason,
  };
}
