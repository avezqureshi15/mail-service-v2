import { Router } from 'express';
import { env } from '../config/env.js';
import { readUnsubscribeToken } from '../mail/tokens.js';
import { unsubscribeLimiter } from '../middleware/index.js';
import { applyUnsubscribe } from '../lib/apply-unsubscribe.js';

export const unsubscribeRouter = Router();

/**
 * Unsubscribe handling.
 *
 * GET renders a confirmation page and changes nothing. POST performs the
 * opt-out. That split is deliberate: corporate security gateways and link
 * prefetchers follow every URL in an email, so a GET that unsubscribed
 * directly would quietly remove people who never clicked. RFC 8058 one-click
 * clients send POST, so Gmail's and Yahoo's native Unsubscribe button still
 * works instantly - both paths behave correctly.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page({ title, heading, body, token = null, showButton = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f4f5f7; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         color:#1a1a1a; padding:24px; }
  .card { background:#fff; border-radius:12px; padding:40px; max-width:460px; width:100%;
          box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06); }
  h1 { font-size:20px; margin:0 0 12px; }
  p { font-size:15px; line-height:1.55; color:#444; margin:0 0 16px; }
  .email { font-weight:600; color:#1a1a1a; word-break:break-all; }
  button { background:#b4232c; color:#fff; border:0; border-radius:8px; padding:12px 22px;
           font-size:15px; font-weight:600; cursor:pointer; width:100%; }
  button:hover { background:#95171f; }
  .muted { font-size:13px; color:#777; margin-top:20px; margin-bottom:0; }
  .ok { color:#1a7f44; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    ${body}
    ${showButton ? `<form method="POST" action="/u/${encodeURIComponent(token)}"><button type="submit">Unsubscribe me</button></form>` : ''}
    <p class="muted">${escapeHtml(env.MAIL_FROM_NAME)} &middot; ${escapeHtml(env.COMPANY_POSTAL_ADDRESS)}</p>
  </div>
</body>
</html>`;
}

/** Confirmation page. Deliberately read-only. */
unsubscribeRouter.get('/u/:token', unsubscribeLimiter, (req, res) => {
  const payload = readUnsubscribeToken(req.params.token);

  if (!payload) {
    return res.status(400).type('html').send(page({
      title: 'Invalid link',
      heading: 'This unsubscribe link is not valid',
      body: '<p>The link may be incomplete or may have been altered. Please reply to the email you received and we will remove you manually.</p>',
    }));
  }

  res.type('html').send(page({
    title: 'Unsubscribe',
    heading: 'Unsubscribe from our emails?',
    body: `<p>Confirm that you want to stop receiving emails at <span class="email">${escapeHtml(payload.email)}</span>.</p>
           <p>This is permanent and applies to all our mailings, not just this one.</p>`,
    token: req.params.token,
    showButton: true,
  }));
});

/**
 * Performs the opt-out. Reached by the confirmation form and by RFC 8058
 * one-click clients, which POST directly to the List-Unsubscribe URL.
 */
unsubscribeRouter.post('/u/:token', unsubscribeLimiter, async (req, res, next) => {
  const payload = readUnsubscribeToken(req.params.token);

  if (!payload) {
    const invalid = { error: 'Invalid or expired unsubscribe link' };
    return wantsJson(req)
      ? res.status(400).json(invalid)
      : res.status(400).type('html').send(page({
        title: 'Invalid link',
        heading: 'This unsubscribe link is not valid',
        body: '<p>Please reply to the email you received and we will remove you manually.</p>',
      }));
  }

  // One-click requests carry the RFC 8058 form body; a browser submission
  // comes from our own confirmation page.
  const isOneClick = req.body?.['List-Unsubscribe'] === 'One-Click';

  try {
    await applyUnsubscribe({
      email: payload.email,
      contactId: payload.contactId,
      campaignId: payload.campaignId,
      method: isOneClick ? 'one_click' : 'link',
      ip: req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
    });
  } catch (error) {
    // Nothing recorded, so nothing may claim otherwise. Someone told that
    // they are unsubscribed while they are still on the list reaches for the
    // spam button the next time we mail them, which costs far more than the
    // error page does.
    return next(error);
  }

  // Mail clients expect a bare 200 and show their own confirmation.
  if (isOneClick || wantsJson(req)) {
    return res.status(200).json({ ok: true, unsubscribed: payload.email });
  }

  res.type('html').send(page({
    title: 'Unsubscribed',
    heading: 'You have been unsubscribed',
    body: `<p class="ok">${escapeHtml(payload.email)} has been removed.</p>
           <p>You will not receive further emails from us. If this was a mistake, reply to any earlier email and we will add you back.</p>`,
  }));
});

function wantsJson(req) {
  return (req.get('accept') ?? '').includes('application/json');
}
