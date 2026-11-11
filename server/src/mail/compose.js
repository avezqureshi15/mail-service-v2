import sanitizeHtml from 'sanitize-html';
import { env } from '../config/env.js';
import { htmlToText } from './plaintext.js';
import { createUnsubscribeToken, createMessageId } from './tokens.js';
import { applyTracking } from './tracking.js';

/**
 * Builds the message that actually goes on the wire.
 *
 * Two things are enforced here rather than left to the person writing the
 * campaign: every message gets a genuine plain-text alternative, and every
 * message gets a working unsubscribe - both the visible footer link and the
 * RFC 8058 one-click headers.
 */

// Deliberately narrow. Mail clients support a small subset of HTML, and
// anything executable is both useless and a spam signal.
const SANITIZE_OPTIONS = {
  allowedTags: [
    'a', 'b', 'blockquote', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr',
    'i', 'img', 'li', 'ol', 'p', 'span', 'strong', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'style'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'cellpadding', 'cellspacing', 'border'],
  },
  // No javascript: or data: URLs.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Drop the *contents* of these, not just the tags. Templates are often
  // whole HTML documents, and without this the text inside <title> survives
  // the strip and appears as a stray word at the top of the email body.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
};

export function sanitizeBody(html) {
  return sanitizeHtml(html ?? '', SANITIZE_OPTIONS);
}

/**
 * Replaces {{field}} with contact data. Values are HTML-escaped when the
 * target is the HTML body, so a contact name containing markup cannot inject
 * anything into the message.
 */
export function renderMergeFields(template, contact, { escape = true } = {}) {
  if (!template) return '';

  const custom = safeParse(contact.custom_fields);
  const values = {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
    company: contact.company || '',
    email: contact.email || '',
    ...custom,
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    if (value === undefined || value === null) return match;
    return escape ? escapeHtml(String(value)) : String(value);
  });
}

function safeParse(json) {
  try {
    const parsed = JSON.parse(json ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Prefixes a follow-up's subject with "Re:".
 *
 * Follow-ups already thread correctly - In-Reply-To and References do that
 * work, and mail clients group on those rather than on the subject. But a
 * step with no subject of its own inherits the campaign's, so without this
 * the thread reads as the same fresh subject line sent three times, which
 * looks automated to a recipient reading it top to bottom.
 *
 * Only ever one "Re:" - mail clients already dislike the "Re: Re: Re:" that
 * naive prefixing produces, and so do people.
 */
function threadedSubject(subject, threadMessageId) {
  if (!threadMessageId || !subject) return subject;
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unsubscribeUrl(token) {
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/u/${token}`;
}

/**
 * Appended to every message. Contains the two things a commercial email is
 * required to carry: a working opt-out and a real postal address.
 */
export function buildFooter(unsubUrl) {
  return [
    '<div style="margin-top:28px;padding-top:14px;border-top:1px solid #dddddd;',
    'font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#666666;">',
    `<p style="margin:0 0 6px 0;">${escapeHtml(env.COMPANY_POSTAL_ADDRESS)}</p>`,
    `<p style="margin:0;">Not interested? <a href="${unsubUrl}" style="color:#666666;text-decoration:underline;">Unsubscribe</a> and you will not hear from us again.</p>`,
    '</div>',
  ].join('');
}

export function bodyHasUnsubscribe(html) {
  return /\{\{\s*unsubscribe_url\s*\}\}/i.test(html ?? '') || /unsubscrib/i.test(html ?? '');
}

/**
 * Hidden preview text shown by mail clients in the inbox list, right after
 * the subject. Padded with zero-width characters so a client's preview snippet
 * is filled entirely by this text rather than spilling into the first line of
 * the visible body.
 */
export function buildPreheader(text) {
  if (!text) return '';
  const padding = '&#8202;&zwnj;'.repeat(120);
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}${padding}</div>`;
}

/**
 * Assembles everything nodemailer needs for one recipient.
 *
 * @returns {{ message: object, messageId: string, unsubscribeUrl: string }}
 */
export function composeMessage({
  campaign,
  step,
  contact,
  // The mailbox this campaign sends from. Required, with no env fallback:
  // silently defaulting to a process-wide address is how a message ends up
  // going out from the wrong account with nothing in the logs to show it.
  mailbox,
  // Message-ID of step 1, so a follow-up threads onto the original
  // conversation instead of arriving as a fresh cold email.
  threadMessageId = null,
}) {
  if (!mailbox) throw new Error("composeMessage requires the campaign's mailbox");

  // On the mailbox's own sending domain, not a global one. A Message-ID whose
  // domain does not match the From domain is a mild spam signal in its own
  // right, and the inbox poller uses the match to recognise our own mail.
  const messageId = createMessageId(mailbox.sending_domain);

  const token = createUnsubscribeToken({
    contactId: contact.id,
    campaignId: campaign.id,
    email: contact.email,
  });
  const unsubUrl = unsubscribeUrl(token);

  const subject = threadedSubject(
    renderMergeFields(step.subject || campaign.subject, contact, { escape: false }).trim(),
    threadMessageId,
  );

  // Sanitise first, then merge, then inject the footer - so a merge value can
  // never introduce markup and the footer we add is never stripped.
  let html = sanitizeBody(step.html_body || campaign.html_body);
  html = renderMergeFields(html, contact);
  html = html.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubUrl);

  // The footer is injected unless the author already placed the link
  // themselves, so a campaign without an opt-out is not possible.
  if (!/\{\{\s*unsubscribe_url\s*\}\}/i.test(step.html_body || campaign.html_body)) {
    html += buildFooter(unsubUrl);
  }

  const preheaderText = renderMergeFields(
    step.preheader || campaign.preheader,
    contact,
    { escape: false },
  ).trim();
  if (preheaderText) html = buildPreheader(preheaderText) + html;

  if (campaign.tracking_enabled && env.trackingEnabled) {
    html = applyTracking(html, {
      contactId: contact.id,
      campaignId: campaign.id,
      messageId,
      unsubscribeUrl: unsubUrl,
    });
  }

  const text = htmlToText(html);

  const fromName = campaign.from_name || mailbox.from_name;
  // A campaign may still override the address where the provider permits it
  // (a verified Zoho alias, say). Where the provider rewrites anything other
  // than the authenticated mailbox - Gmail does - the override is refused
  // when the campaign is started, not silently honoured here and rewritten
  // in flight, which would break DKIM alignment with no error anywhere.
  const fromAddress = campaign.from_email || mailbox.from_email;
  const replyTo = campaign.reply_to || mailbox.reply_to || mailbox.from_email;

  const headers = {
    // RFC 8058. Gmail and Yahoo surface a native Unsubscribe control when
    // both of these are present, which keeps complaints off the spam button.
    'List-Unsubscribe': `<${unsubUrl}>, <mailto:${fromAddress}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  if (threadMessageId) {
    headers['In-Reply-To'] = threadMessageId;
    headers.References = threadMessageId;
  }

  return {
    messageId,
    unsubscribeUrl: unsubUrl,
    message: {
      from: { name: fromName, address: fromAddress },
      to: contact.email,
      replyTo,
      subject,
      text,
      html,
      messageId,
      headers,
      // Nodemailer would otherwise advertise itself in an X-Mailer header.
      xMailer: false,
    },
  };
}
