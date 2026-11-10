import { env } from '../config/env.js';
import { createOpenToken, createClickToken } from './tokens.js';

/**
 * Open and click tracking. Only applied when the campaign opts in - it is off
 * by default because a pixel and rewritten links both cost inbox placement.
 *
 * Links point at TRACKING_DOMAIN, which env.js requires to be a subdomain of
 * the sending domain. A shared or third-party tracking domain carries other
 * senders' reputation and is routinely blocklisted.
 */

// 1x1 transparent GIF.
export const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function trackingBase() {
  const domain = env.TRACKING_DOMAIN;
  if (!domain) return null;
  return domain.startsWith('http') ? domain.replace(/\/$/, '') : `https://${domain}`;
}

export function openUrl(payload) {
  const base = trackingBase();
  if (!base) return null;
  return `${base}/t/o/${createOpenToken(payload)}`;
}

export function clickUrl(payload) {
  const base = trackingBase();
  if (!base) return null;
  return `${base}/t/c/${createClickToken(payload)}`;
}

/**
 * Rewrites outbound links and appends the open pixel.
 *
 * The unsubscribe link is never rewritten: it has to keep working even if
 * tracking is misconfigured, and routing an opt-out through a tracker looks
 * like exactly the dark pattern recipients report as spam.
 */
export function applyTracking(html, { contactId, campaignId, messageId, unsubscribeUrl }) {
  const base = trackingBase();
  if (!base) return html;

  let output = html.replace(
    /(<a\b[^>]*\bhref\s*=\s*)(["'])([^"']+)\2/gi,
    (match, prefix, quote, url) => {
      if (url === unsubscribeUrl) return match;
      if (!/^https?:\/\//i.test(url)) return match;
      // Already a tracking link (e.g. re-sent draft).
      if (url.startsWith(base)) return match;

      const rewritten = clickUrl({ contactId, campaignId, messageId, url });
      return rewritten ? `${prefix}${quote}${rewritten}${quote}` : match;
    },
  );

  const pixel = openUrl({ contactId, campaignId, messageId });
  if (pixel) {
    output += `<img src="${pixel}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  }

  return output;
}

// Machine traffic that would otherwise inflate every number. Corporate
// security gateways open and click every URL in a message before the human
// ever sees it, and Apple Mail Privacy Protection pre-fetches images.
const BOT_PATTERNS = [
  /googleimageproxy/i,
  /ggpht/i,
  /yahoomailproxy/i,
  /microsoft office/i,
  /outlook-ios|outlook-android/i,
  /proofpoint|mimecast|barracuda|symantec|forcepoint|ironport|fireeye/i,
  /safelinks/i,
  /bitdefender|kaspersky|avast|mcafee|sophos/i,
  /bot|crawler|spider|preview|scanner|monitor|probe/i,
  /curl|wget|python-requests|axios|go-http-client|libwww/i,
  /^$/,
];

/**
 * @param {string} userAgent
 * @param {number|null} secondsSinceSend  Hits arriving within a few seconds of
 *   delivery are a gateway pre-fetch, not a human reading the message.
 */
export function looksLikeBot(userAgent = '', secondsSinceSend = null) {
  if (secondsSinceSend !== null && secondsSinceSend >= 0 && secondsSinceSend < 10) return true;
  const ua = (userAgent ?? '').trim();
  return BOT_PATTERNS.some((pattern) => pattern.test(ua));
}
