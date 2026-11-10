/**
 * Turns a template's HTML into a list of plain-text fields a salesperson can
 * edit, and writes their edits back without disturbing the markup.
 *
 * The templates are complete HTML documents - several hundred lines of CSS
 * before the first sentence. Nobody writing outreach should have to find the
 * words inside that, so the editor shows only the words.
 */

// Never surface these, and never treat their contents as copy.
const SKIP_TAGS = new Set([
  'STYLE', 'SCRIPT', 'TITLE', 'HEAD', 'META', 'LINK', 'NOSCRIPT', 'BASE',
]);

// Inline tags belong to the sentence around them rather than forming a field
// of their own, so "Dear <span>{{first_name}}</span>," stays one field.
const INLINE_TAGS = new Set([
  'SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'U', 'SMALL', 'BR', 'SUP', 'SUB',
  'CODE', 'FONT', 'MARK', 'ABBR', 'TIME',
]);

/** Human label for a field, from its class name first and tag as a fallback. */
const CLASS_LABELS = [
  [/logo/, 'Logo text'],
  [/tagline|subtitle|subheading/, 'Subtitle'],
  [/greeting|salutation/, 'Greeting'],
  [/title|heading|headline/, 'Heading'],
  [/button|cta|btn/, 'Button text'],
  [/benefit|feature|item|bullet/, 'List item'],
  [/signature|signoff/, 'Signature'],
  [/closing/, 'Closing'],
  [/footer/, 'Footer text'],
  [/quote|testimonial/, 'Quote'],
  [/stat|metric|number/, 'Statistic'],
  [/label|tag|badge|eyebrow/, 'Label'],
  [/body|paragraph|text|content|description/, 'Paragraph'],
];

const TAG_LABELS = {
  H1: 'Heading', H2: 'Heading', H3: 'Subheading', H4: 'Subheading',
  H5: 'Subheading', H6: 'Subheading',
  P: 'Paragraph', LI: 'List item', TD: 'Cell', TH: 'Cell',
  A: 'Link text', BLOCKQUOTE: 'Quote', FIGCAPTION: 'Caption',
};

function labelFor(el) {
  const className = (el.getAttribute('class') ?? '').toLowerCase();
  for (const [pattern, label] of CLASS_LABELS) {
    if (pattern.test(className)) return label;
  }
  return TAG_LABELS[el.tagName] ?? 'Text';
}

/** Groups fields under Header / Body / Footer so a long template stays readable. */
const SECTION_PATTERNS = [
  [/header|hero|banner|masthead/, 'Header'],
  [/footer/, 'Footer'],
  [/content|body|main|article/, 'Body'],
];

function sectionFor(el) {
  let node = el;
  while (node && node.tagName !== 'BODY') {
    const className = (node.getAttribute?.('class') ?? '').toLowerCase();
    for (const [pattern, name] of SECTION_PATTERNS) {
      if (pattern.test(className)) return name;
    }
    node = node.parentElement;
  }
  return 'Body';
}

/**
 * True when this element is the innermost thing holding copy: it has text,
 * and no block-level child that holds text of its own.
 */
// Anything with no letters or digits is decoration - the tick glyphs beside
// bullet points, arrows, bare punctuation. Offering those as editable fields
// buries the actual copy in noise.
const HAS_WORDS = /[\p{L}\p{N}]/u;

function holdsEditableText(el) {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (!el.textContent.trim()) return false;
  if (!HAS_WORDS.test(el.textContent)) return false;

  for (const child of el.children) {
    if (SKIP_TAGS.has(child.tagName)) continue;
    if (INLINE_TAGS.has(child.tagName)) continue;
    if (child.textContent.trim()) return false;
  }
  return true;
}

function parse(html) {
  return new DOMParser().parseFromString(html ?? '', 'text/html');
}

/**
 * Walks the document in order and assigns each editable element an index.
 * Both extraction and write-back use the same walk, so an index always means
 * the same element.
 */
function editableElements(doc) {
  const found = [];
  const walk = (el) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    if (holdsEditableText(el)) {
      found.push(el);
      return; // Do not descend - its inline children are part of this field.
    }
    for (const child of el.children) walk(child);
  };
  if (doc.body) walk(doc.body);
  return found;
}

/** `<br>` becomes a newline so multi-line blocks edit naturally. */
function elementToText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return clone.textContent
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    // A <br> next to a newline in the source would otherwise read as a blank
    // line the author never wrote.
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * @returns {{index:number, label:string, section:string, text:string, multiline:boolean}[]}
 */
export function extractFields(html) {
  const doc = parse(html);
  return editableElements(doc).map((el, index) => {
    const text = elementToText(el);
    return {
      index,
      label: labelFor(el),
      section: sectionFor(el),
      text,
      multiline: text.length > 80 || text.includes('\n'),
    };
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Writes edited text back into the HTML.
 *
 * Only fields whose text actually changed are touched. An untouched field
 * keeps its original markup byte for byte, including any inline styling - so
 * editing one paragraph cannot quietly strip formatting from the rest.
 *
 * A field that *is* edited becomes plain text (with newlines as `<br>`), since
 * there is no way to know where the old inline tags belong in new wording.
 *
 * @param {string} html
 * @param {Record<number, string>} edits  index -> new text
 */
export function applyFieldEdits(html, edits) {
  const entries = Object.entries(edits);
  if (entries.length === 0) return html;

  const doc = parse(html);
  const elements = editableElements(doc);
  let changed = false;

  for (const [key, value] of entries) {
    const el = elements[Number(key)];
    if (!el) continue;
    if (elementToText(el) === value) continue;

    el.innerHTML = escapeHtml(value).replace(/\n/g, '<br>');
    changed = true;
  }

  if (!changed) return html;
  return serialise(doc, html);
}

// --- Links -----------------------------------------------------------------

// Templates ship with href="#" placeholders. A rep needs to set those without
// going near the markup, and changing an attribute leaves styling untouched.
function linkElements(doc) {
  return [...doc.querySelectorAll('a[href]')].filter((a) => {
    const href = a.getAttribute('href') ?? '';
    // mailto: links are generated from the sender identity, and the
    // unsubscribe link is injected at send time - neither is the rep's to set.
    if (href.startsWith('mailto:')) return false;
    if (/unsubscrib/i.test(a.textContent)) return false;
    return true;
  });
}

/**
 * @returns {{index:number, text:string, href:string, isPlaceholder:boolean}[]}
 */
export function extractLinks(html) {
  const doc = parse(html);
  return linkElements(doc).map((a, index) => {
    const href = a.getAttribute('href') ?? '';
    return {
      index,
      text: a.textContent.trim() || '(no text)',
      href,
      isPlaceholder: href === '' || href === '#',
    };
  });
}

/** @param {Record<number, string>} edits index -> new href */
export function applyLinkEdits(html, edits) {
  const entries = Object.entries(edits);
  if (entries.length === 0) return html;

  const doc = parse(html);
  const links = linkElements(doc);
  let changed = false;

  for (const [key, value] of entries) {
    const a = links[Number(key)];
    if (!a) continue;
    if ((a.getAttribute('href') ?? '') === value) continue;
    a.setAttribute('href', value);
    changed = true;
  }

  if (!changed) return html;
  return serialise(doc, html);
}

/**
 * Serialises back to a string, keeping the original doctype so the template
 * still renders as its author intended.
 */
function serialise(doc, originalHtml) {
  const hasDoctype = /^\s*<!doctype/i.test(originalHtml);
  const isFullDocument = /<html[\s>]/i.test(originalHtml);

  if (isFullDocument) {
    const doctype = hasDoctype ? '<!DOCTYPE html>\n' : '';
    return doctype + doc.documentElement.outerHTML;
  }
  // A fragment went in, so a fragment comes out.
  return doc.body.innerHTML;
}
