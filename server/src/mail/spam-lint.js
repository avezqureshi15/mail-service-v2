import { htmlToText } from './plaintext.js';

/**
 * Pre-send content checks.
 *
 * Severity 'block' prevents the campaign being sent at all; 'warn' is advice
 * shown live in the composer. The blocking rules are the legal and
 * reputational non-negotiables - everything else is coaching so reps do not
 * need to memorise filter heuristics.
 */

// Shorteners hide the real destination, are heavily abused, and are treated
// as a strong negative signal by most filters.
const URL_SHORTENERS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'buff.ly', 'is.gd',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 's.id',
];

const TRIGGER_PHRASES = [
  'act now', 'apply now', 'buy direct', 'call now', 'cash bonus', 'cheap',
  'click below', 'click here', 'congratulations', 'credit card offer',
  'dear friend', 'double your', 'earn extra cash', 'eliminate debt',
  'financial freedom', 'for free', 'free access', 'free gift', 'free money',
  'free trial', 'get paid', 'guarantee', 'income from home', 'increase sales',
  'limited time', 'lowest price', 'make money', 'miracle', 'no catch',
  'no cost', 'no credit check', 'no obligation', 'no strings attached',
  'offer expires', 'once in a lifetime', 'order now', 'risk free',
  'satisfaction guaranteed', 'special promotion', 'this is not spam',
  'urgent', 'while supplies last', 'winner', 'work from home',
];

function finding(severity, code, message, hint = '') {
  return { severity, code, message, hint };
}

function extractLinks(html) {
  const links = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    links.push(match[1]);
  }
  return links;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * @param {object} input
 * @param {string} input.subject
 * @param {string} input.html          Body as authored, before footer injection.
 * @param {string} input.sendingDomain
 * @param {boolean} input.hasUnsubscribe  Whether the footer link is present or will be injected.
 * @param {boolean} input.hasPostalAddress
 */
export function lintContent({
  subject = '',
  html = '',
  sendingDomain = '',
  hasUnsubscribe = true,
  hasPostalAddress = true,
}) {
  const findings = [];
  const text = htmlToText(html);
  const words = text.split(/\s+/).filter(Boolean);

  // --- Blocking rules ------------------------------------------------------

  if (!subject.trim()) {
    findings.push(finding('block', 'subject_empty', 'Subject line is empty.'));
  }
  if (!text.trim()) {
    findings.push(finding('block', 'body_empty', 'Message body is empty.'));
  }
  if (!hasUnsubscribe) {
    findings.push(
      finding('block', 'no_unsubscribe', 'No unsubscribe link in the body.',
        'A visible unsubscribe is required by law and is what stops recipients reporting the message as spam instead.'),
    );
  }
  if (!hasPostalAddress) {
    findings.push(
      finding('block', 'no_postal_address', 'No physical postal address in the footer.',
        'CAN-SPAM requires one in every commercial email. Set COMPANY_POSTAL_ADDRESS so it is appended automatically.'),
    );
  }

  const links = extractLinks(html);
  for (const link of links) {
    const host = hostOf(link);
    if (host && URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) {
      findings.push(
        finding('block', 'url_shortener', `Link uses the shortener ${host}.`,
          'Shorteners conceal the destination and are filtered aggressively. Link to the real URL.'),
      );
    }
  }

  // --- Warnings ------------------------------------------------------------

  const subjectLetters = subject.replace(/[^A-Za-z]/g, '');
  if (subjectLetters.length >= 6 && subjectLetters === subjectLetters.toUpperCase()) {
    findings.push(finding('warn', 'subject_caps', 'Subject is in all capitals.', 'Reads as shouting and is a classic filter trigger.'));
  }
  if (subject.length > 78) {
    findings.push(finding('warn', 'subject_long', `Subject is ${subject.length} characters.`, 'Most clients truncate around 50-60. Front-load the point.'));
  }
  if (/[!?]{2,}/.test(subject) || /[!?]{3,}/.test(text)) {
    findings.push(finding('warn', 'excess_punctuation', 'Repeated exclamation or question marks.'));
  }
  // Only the shouted form; lower-case "free trial" is covered by the trigger
  // phrase list below at a lower severity.
  if (/\bFREE\b/.test(subject) || /\$\$|€€/.test(`${subject} ${text}`)) {
    findings.push(finding('warn', 'money_symbols', 'Shouted FREE or repeated currency symbols.'));
  }

  const haystack = `${subject}\n${text}`.toLowerCase();
  const matched = TRIGGER_PHRASES.filter((phrase) => haystack.includes(phrase));
  if (matched.length > 0) {
    findings.push(
      finding(matched.length >= 3 ? 'warn' : 'info', 'trigger_phrases',
        `Contains ${matched.length} common filter trigger phrase${matched.length === 1 ? '' : 's'}: ${matched.slice(0, 6).join(', ')}${matched.length > 6 ? '...' : ''}`,
        'One or two is usually fine. Several together materially raises the spam score.'),
    );
  }

  const imageCount = (html.match(/<img\b/gi) ?? []).length;
  if (imageCount > 0 && words.length < 40) {
    findings.push(
      finding('warn', 'image_heavy', `Only ${words.length} words of text alongside ${imageCount} image(s).`,
        'Image-only emails are a standard spam pattern - filters cannot read them, so they judge on the little text there is.'),
    );
  }
  if (words.length < 20) {
    findings.push(finding('warn', 'body_short', `Body is only ${words.length} words.`, 'Very short cold emails read as templated bulk.'));
  }
  if (words.length > 700) {
    findings.push(finding('info', 'body_long', `Body is ${words.length} words.`, 'Long cold emails rarely get read to the end.'));
  }

  if (links.length > 8) {
    findings.push(finding('warn', 'many_links', `${links.length} links in the body.`, 'Keep cold outreach to one or two.'));
  }

  if (sendingDomain) {
    const offDomain = new Set();
    for (const link of links) {
      const host = hostOf(link);
      if (!host) continue;
      if (host === sendingDomain || host.endsWith(`.${sendingDomain}`)) continue;
      offDomain.add(host);
    }
    if (offDomain.size > 0) {
      findings.push(
        finding('info', 'off_domain_links', `Links point to ${[...offDomain].slice(0, 4).join(', ')}.`,
          `Links on the sending domain (${sendingDomain}) align best with the authenticated sender.`),
      );
    }
  }

  if (/<script\b/i.test(html) || /\son\w+\s*=/i.test(html)) {
    findings.push(finding('warn', 'active_content', 'Body contains script or event handlers.', 'These are stripped before sending; no mail client executes them.'));
  }
  if (/<(iframe|form|object|embed)\b/i.test(html)) {
    findings.push(finding('warn', 'unsupported_elements', 'Body contains iframe/form/object/embed.', 'Stripped before sending and widely treated as suspicious.'));
  }
  if (/style\s*=\s*["'][^"']*display\s*:\s*none/i.test(html) || /color\s*:\s*#?f{3,6}\b/i.test(html)) {
    findings.push(finding('warn', 'hidden_text', 'Possible hidden or white-on-white text.', 'Filters treat concealed text as deliberate evasion.'));
  }

  if (!/\{\{\s*\w+\s*\}\}/.test(`${subject}${html}`)) {
    findings.push(finding('info', 'no_personalisation', 'No merge fields used.', 'Identical copy to every recipient is easier to fingerprint as bulk. Try {{first_name}}.'));
  }

  // --- Score ---------------------------------------------------------------

  const weights = { block: 25, warn: 8, info: 2 };
  const penalty = findings.reduce((total, f) => total + (weights[f.severity] ?? 0), 0);
  const score = Math.max(0, 100 - penalty);

  return {
    score,
    rating: score >= 85 ? 'good' : score >= 65 ? 'fair' : 'poor',
    canSend: !findings.some((f) => f.severity === 'block'),
    findings,
    stats: {
      words: words.length,
      links: links.length,
      images: imageCount,
      subjectLength: subject.length,
    },
  };
}
