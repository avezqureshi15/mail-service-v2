/**
 * HTML -> readable plain text.
 *
 * Every message ships multipart/alternative with a real text part. HTML-only
 * mail is a well-known spam signal, and an empty or placeholder text part
 * ("view this in HTML") is barely better than none.
 */

const BLOCK_TAGS = 'address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|p|section|table|tfoot|tr';

export function htmlToText(html) {
  if (!html) return '';

  let text = html;

  // Drop content that has no textual meaning.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Keep the destination of links visible, since the reader cannot click
  // through styled anchor text in a plain-text part.
  //
  // The angle brackets are written as sentinels and restored at the very end:
  // emitting a literal "<https://...>" here would be removed again by the
  // catch-all tag strip below, silently dropping every URL from the text part.
  const OPEN = '\u0000';
  const CLOSE = '\u0001';
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      if (!cleanLabel) return href;
      // Avoid the noisy "example.com <https://example.com>" duplication.
      if (cleanLabel === href) return href;
      return `${cleanLabel} ${OPEN}${href}${CLOSE}`;
    },
  );

  text = text.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, '$1');
  text = text.replace(/<img\b[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
  text = text.replace(/<\/(td|th)>\s*<(td|th)[^>]*>/gi, '\t');
  text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '');

  // Anything left over.
  text = text.replace(/<[^>]+>/g, '');

  text = decodeEntities(text);

  // Tidy whitespace without collapsing deliberate paragraph breaks.
  text = text.replace(/\r\n?/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Restore the link-destination brackets now that tag stripping is done.
  text = text.replaceAll(OPEN, '<').replaceAll(CLOSE, '>');

  return text.trim();
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  trade: '™',
  reg: '®',
  copy: '©',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
