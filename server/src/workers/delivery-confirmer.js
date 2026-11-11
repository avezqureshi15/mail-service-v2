/**
 * Turns silence into evidence, carefully.
 *
 * Without this the predictor only ever learns from replies, and cold
 * outreach replies run at a few percent. Every other company would release
 * one probe address and then stay locked out forever, because nothing else
 * promotes it out of probation. That makes the probation gate a one-way
 * door rather than a safety measure.
 *
 * A message sent 48 hours ago with no bounce, no suppression and nothing in
 * the bounce log is as close to "delivered" as SMTP gets without a read
 * receipt. That is enough to let a company out of probation. It is *not*
 * enough to call the format proven - a catch-all domain produces exactly
 * this signal for every address, real or not - so delivery counts towards
 * the evidence while only a reply promotes the format.
 *
 * Runs only when IMAP is on. With bounce detection off, nothing would ever
 * report a failure, so silence would mean nothing and this would confirm
 * every guess ever made.
 */

import { env } from '../config/env.js';
import {
  predictionsAwaitingConfirmation, recordPredictionEvent,
  refreshPredictionOutcome, confirmPattern,
} from '../db/repositories/predictions.js';

// Long enough for a deferred message to finish retrying and bounce. Most
// providers give up well inside this; a few stretch to 72h, which is why
// a late bounce is still recorded and still demotes the format.
const DEFAULT_AFTER_HOURS = 48;
const EVERY_MS = 30 * 60 * 1000;

let timer = null;
let running = false;

const log = (message) => console.log(`[delivery] ${message}`);

/**
 * One pass. Exported so it can be run on demand and tested without the
 * timer.
 *
 * @returns {Promise<{confirmed: number, examined: number}>}
 */
export async function confirmQuietDeliveries({
  afterHours = DEFAULT_AFTER_HOURS, limit = 500, tenantId = 1,
} = {}) {
  const due = await predictionsAwaitingConfirmation({ afterHours, limit, tenantId });
  let confirmed = 0;

  for (const row of due) {
    try {
      // The send's Message-ID makes this idempotent through the unique
      // index, so a second pass over the same prediction cannot count
      // twice even if the query below ever stops excluding it.
      const inserted = await recordPredictionEvent({
        predictionId: row.id,
        contactId: row.contact_id,
        email: row.predicted_email,
        eventType: 'accepted',
        messageId: row.message_id ?? '',
        learnsAddress: null,
        metadata: { afterHours, basis: 'no bounce within the window' },
        tenantId,
      });
      if (inserted === 0) continue;

      await refreshPredictionOutcome(row.id);
      await confirmPattern({
        domain: row.domain, pattern: row.pattern, strong: false, tenantId,
      });
      confirmed += 1;
    } catch (error) {
      // One bad row must not stop the sweep.
      log(`could not confirm ${row.predicted_email}: ${error.message}`);
    }
  }

  return { confirmed, examined: due.length };
}

async function loop() {
  if (!running) return;

  try {
    const { confirmed, examined } = await confirmQuietDeliveries();
    if (examined > 0) {
      log(`${examined} quiet send(s) examined, ${confirmed} confirmed as delivered`);
    }
  } catch (error) {
    log(`sweep failed: ${error.message}`);
  }

  if (running) timer = setTimeout(loop, EVERY_MS);
}

export function startDeliveryConfirmer() {
  if (running) return;
  if (!env.IMAP_ENABLED) {
    log('disabled (IMAP_ENABLED=false) - without bounce detection, silence proves nothing');
    return;
  }
  running = true;
  log(`worker started, sweeping every ${EVERY_MS / 60000} minutes`);
  // After the inbox poller's first pass, so a bounce already sitting in the
  // mailbox is read before anything is called delivered.
  timer = setTimeout(loop, 90_000);
}

export function stopDeliveryConfirmer() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
