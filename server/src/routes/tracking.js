import { Router } from 'express';
import { readOpenToken, readClickToken } from '../mail/tokens.js';
import { TRACKING_PIXEL, looksLikeBot } from '../mail/tracking.js';
import { execute } from '../db/index.js';
import { findJobByMessageId } from '../db/repositories/jobs.js';
import { trackingLimiter } from '../middleware/index.js';

export const trackingRouter = Router();

function recordEvent(values) {
  return execute(
    `INSERT INTO tracking_events (message_id, contact_id, campaign_id, event_type, url, user_agent, ip, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    values,
  );
}

/**
 * Seconds between the message being sent and this hit. A gateway pre-fetch
 * arrives within moments of delivery; a human read does not.
 */
async function secondsSinceSend(messageId) {
  const job = await findJobByMessageId(messageId);
  if (!job?.sent_at) return null;
  return (Date.now() - job.sent_at.getTime()) / 1000;
}

/*
 * Both handlers respond first and record afterwards.
 *
 * Recording now costs a network round trip rather than a local file write, and
 * nothing the recipient sees depends on it finishing - so it must not sit in
 * front of the pixel or the redirect. Failures are swallowed for the same
 * reason they always were: a tracking write must never break image loading in
 * someone's inbox, or stop someone reaching the page they clicked.
 */

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
}

/** Open pixel. Always returns the GIF, even for a bad token. */
trackingRouter.get('/t/o/:token', trackingLimiter, (req, res) => {
  const payload = readOpenToken(req.params.token);
  const userAgent = req.get('user-agent') ?? '';
  const ip = req.ip ?? '';

  noStore(res);
  res.type('image/gif').send(TRACKING_PIXEL);

  if (payload) {
    secondsSinceSend(payload.messageId)
      .then((age) => recordEvent([
        payload.messageId,
        payload.contactId,
        payload.campaignId,
        'open',
        '',
        userAgent,
        ip,
        looksLikeBot(userAgent, age),
      ]))
      .catch(() => {});
  }
});

/**
 * Click redirect.
 *
 * The destination is read from inside the signed token, never from a query
 * parameter. An unsigned redirect parameter would make this an open redirect,
 * and an open redirect on the sending domain is a fast route to a blocklist.
 */
trackingRouter.get('/t/c/:token', trackingLimiter, (req, res) => {
  const payload = readClickToken(req.params.token);

  if (!payload?.url) {
    return res.status(400).type('text/plain').send('Invalid link.');
  }

  // Belt and braces: even a validly signed token only ever redirects to http
  // or https, so a bad value could never become javascript: or data:.
  let destination;
  try {
    destination = new URL(payload.url);
  } catch {
    return res.status(400).type('text/plain').send('Invalid link.');
  }
  if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
    return res.status(400).type('text/plain').send('Invalid link.');
  }

  const userAgent = req.get('user-agent') ?? '';
  const ip = req.ip ?? '';

  noStore(res);
  res.redirect(302, destination.href);

  secondsSinceSend(payload.messageId)
    .then((age) => recordEvent([
      payload.messageId,
      payload.contactId,
      payload.campaignId,
      'click',
      destination.href.slice(0, 2000),
      userAgent,
      ip,
      looksLikeBot(userAgent, age),
    ]))
    .catch(() => {});
});
