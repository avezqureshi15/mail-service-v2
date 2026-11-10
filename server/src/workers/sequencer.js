import { queryOne, execute } from '../db/index.js';
import { dueEnrollments, getStep, countSteps, completeEnrollment, exitEnrollment } from '../db/repositories/campaigns.js';
import { queueSingleJob } from '../db/repositories/jobs.js';
import { isSuppressed } from '../db/repositories/suppressions.js';

/**
 * Turns due sequence enrollments into send jobs.
 *
 * It only ever enqueues - the sender worker does the sending, so follow-ups
 * obey exactly the same daily cap, warm-up ramp and per-domain pacing as a
 * first touch. There is no path by which a sequence can send faster than a
 * normal campaign.
 */

const INTERVAL_MS = 60_000;

let timer = null;
let running = false;

const log = (...args) => console.log('[sequencer]', ...args);

/**
 * Re-checked immediately before enqueuing, not just when the step was
 * scheduled: a reply or unsubscribe that arrived during the wait must stop
 * the follow-up. This is the guarantee that nobody gets a "just bumping
 * this" after they already answered.
 */
async function exitReasonFor(enrollment) {
  if (enrollment.contact_status === 'unsubscribed') return 'unsubscribed';
  if (enrollment.contact_status === 'bounced') return 'bounced';
  if (enrollment.contact_status === 'complained') return 'complained';
  if (await isSuppressed(enrollment.email, enrollment.tenant_id)) return 'unsubscribed';

  const replied = await queryOne(
    'SELECT 1 FROM replies WHERE contact_id = $1 AND campaign_id = $2 LIMIT 1',
    [enrollment.contact_id, enrollment.campaign_id],
  );
  if (replied) return 'replied';

  return null;
}

async function processDue() {
  const due = await dueEnrollments(200);
  if (due.length === 0) return { queued: 0, exited: 0 };

  let queued = 0;
  let exited = 0;

  // Deliberately one enrollment at a time rather than in parallel. Each pass
  // writes send jobs, and a burst of concurrent writes to the same tables is
  // how a pool of ten connections gets exhausted by a single worker.
  for (const enrollment of due) {
    const reason = await exitReasonFor(enrollment);
    if (reason) {
      await exitEnrollment({ campaignId: enrollment.campaign_id, contactId: enrollment.contact_id, reason });
      exited += 1;
      continue;
    }

    const nextStepNo = enrollment.current_step + 1;
    const totalSteps = await countSteps(enrollment.campaign_id);

    if (nextStepNo > totalSteps) {
      await completeEnrollment(enrollment.campaign_id, enrollment.contact_id);
      continue;
    }

    if (!await getStep(enrollment.campaign_id, nextStepNo)) {
      await completeEnrollment(enrollment.campaign_id, enrollment.contact_id);
      continue;
    }

    const added = await queueSingleJob({
      campaignId: enrollment.campaign_id,
      contactId: enrollment.contact_id,
      email: enrollment.email,
      stepNo: nextStepNo,
      tenantId: enrollment.tenant_id,
    });

    if (added) {
      queued += 1;
      // Park the enrollment until the sender reports the step as sent, which
      // is what advances current_step. Without this the same step would be
      // enqueued again on the next pass.
      await execute(
        `UPDATE sequence_enrollments
            SET next_run_at = NULL, updated_at = now()
          WHERE campaign_id = $1 AND contact_id = $2`,
        [enrollment.campaign_id, enrollment.contact_id],
      );
    }
  }

  if (queued > 0 || exited > 0) {
    log(`queued ${queued} step(s), exited ${exited} enrollment(s)`);
  }
  return { queued, exited };
}

async function loop() {
  if (!running) return;
  try {
    await processDue();
  } catch (error) {
    console.error('[sequencer] pass failed', error);
  }
  if (running) timer = setTimeout(loop, INTERVAL_MS);
}

export function startSequencer() {
  if (running) return;
  running = true;
  log('worker started');
  timer = setTimeout(loop, 5000);
}

export function stopSequencer() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export { processDue as runSequencerPass };
