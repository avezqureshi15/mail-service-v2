/**
 * Splitting a pasted human name into the parts an address is built from.
 *
 * The input is whatever was in a prospecting sheet, which in practice means
 * a LinkedIn display name: a real name wrapped in job titles, emoji,
 * pronouns, credentials and the occasional nickname.
 *
 *   "Rajesh Kumar Sharma | Scaling eng teams @ Apex 🚀 (he/him)"
 *
 * Rules handle the overwhelming majority at no cost and no latency, which
 * matters on a bulk run: a model call per name is the single biggest
 * latency mistake available here. `confidence: 'ambiguous'` marks the ones
 * worth sending to a model later, and the caller decides whether to bother.
 *
 * Nothing here looks at the address or the domain. A name is a name.
 */

/** Honorifics, including the ones common on Indian business lists. */
const TITLES = new Set([
  'dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'sir', 'madam',
  'rev', 'fr', 'capt', 'captain', 'col', 'colonel', 'lt', 'maj', 'gen',
  'sri', 'shri', 'smt', 'kum', 'er', 'ca', 'adv', 'advocate', 'hon',
]);

/** Letters after a name, never part of it. */
const SUFFIXES = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
  'phd', 'md', 'mba', 'msc', 'bsc', 'ma', 'ba', 'bs', 'ms', 'mtech', 'btech',
  'cpa', 'cfa', 'pmp', 'cissp', 'cma', 'llb', 'llm', 'esq', 'rn', 'do', 'dds',
  'pe', 'aws', 'csm', 'itil', 'ccna', 'mcse',
]);

/**
 * Words that mark everything after a comma as a job title rather than a
 * given name - the difference between "Sharma, Rajesh" and "Rajesh Sharma,
 * Head of Talent".
 */
const TITLE_WORDS = /\b(ceo|cto|coo|cfo|cmo|chro|cio|vp|svp|evp|avp|president|director|manager|head|lead|founder|cofounder|co-founder|partner|principal|chief|officer|president|owner|proprietor|consultant|engineer|developer|architect|analyst|recruiter|specialist|executive|associate|intern|advisor|chairman|chairperson|md|gm|hr|talent|sales|marketing|operations|product|design|data|growth)\b/i;

// Bullet and middot are deliberately absent: they separate a name from a
// headline, so the separator pass below needs to still see them.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

const clean = (word) => word.replace(/[.,]/g, '').toLowerCase();

/**
 * Strips the decoration a display name accumulates, returning the words
 * that might be a name plus any nickname found in brackets or quotes.
 */
function tidy(raw) {
  let text = String(raw ?? '').replace(EMOJI, ' ');

  // Anything in brackets or quotes is a nickname or a pronoun, not a name
  // part - but a nickname is worth keeping as an alternative spelling.
  const asides = [];
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (_m, inner) => {
    asides.push(inner.trim());
    return ' ';
  });
  text = text.replace(/["“”'']([^"“”'']+)["“”'']/g, (_m, inner) => {
    asides.push(inner.trim());
    return ' ';
  });

  // A LinkedIn headline hangs off the name after one of these.
  for (const sep of ['|', '•', '·', ' - ', ' – ', ' — ', '@']) {
    const at = text.indexOf(sep);
    if (at > 0) text = text.slice(0, at);
  }

  // A comma either reverses the name or introduces a job title.
  let reversed = false;
  if (text.includes(',')) {
    const [before, ...rest] = text.split(',');
    const after = rest.join(',').trim();
    if (!after || TITLE_WORDS.test(after) || after.split(/\s+/).length > 2) {
      text = before;                       // "Rajesh Sharma, Head of Talent"
    } else if (before.trim().split(/\s+/).length === 1) {
      text = `${after} ${before}`;         // "Sharma, Rajesh"
      reversed = true;
    } else {
      text = before;
    }
  }

  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    // Any script, not just Latin: `[a-z]` here would silently discard a name
    // written entirely in Devanagari or Han, leaving "no name found".
    .filter((w) => /\p{L}/u.test(w));

  const kept = words.filter((w, i) => {
    const bare = clean(w);
    if (!bare) return false;
    if (i === 0 && TITLES.has(bare)) return false;
    if (i === words.length - 1 && SUFFIXES.has(bare) && words.length > 2) return false;
    return !TITLES.has(bare) && !SUFFIXES.has(bare);
  });

  // Pronouns are the common case for a bracketed aside; they are not names.
  const nicknames = asides
    .filter((a) => /^[a-z' -]{2,}$/i.test(a))
    .filter((a) => !/\b(he|him|she|her|they|them|his|hers|theirs)\b/i.test(a))
    .filter((a) => a.split(/\s+/).length === 1);

  return { words: kept.map((w) => w.replace(/[.,]+$/, '')), nicknames, reversed };
}

/**
 * @returns {{
 *   ok: boolean, first: string, middle: string, last: string,
 *   alternatives: Array<{first: string, middle: string, last: string}>,
 *   confidence: 'clean'|'ambiguous', reason: string|null
 * }}
 */
export function parseName(raw) {
  const fail = (reason) => ({
    ok: false, first: '', middle: '', last: '', alternatives: [],
    confidence: 'ambiguous', reason,
  });

  const { words, nicknames, reversed } = tidy(raw);

  if (words.length === 0) return fail('no_name');
  if (words.length === 1) return fail('single_word_name');

  const first = words[0];
  const last = words[words.length - 1];
  const middle = words.slice(1, -1).join(' ');

  const alternatives = [];

  // "Mike (Michael) Chen" - either spelling may be the one in the mailbox.
  for (const nickname of nicknames) {
    if (clean(nickname) !== clean(first)) {
      alternatives.push({ first: nickname, middle, last });
    }
  }

  // "AJ Khan" - two capitals is as likely to be two initials as a name, and
  // reading it both ways is what turns `ajkhan@` from a miss into a hit.
  if (/^[A-Z]{2,3}$/.test(first)) {
    const letters = first.split('');
    alternatives.push({
      first: letters[0],
      middle: [...letters.slice(1), middle].filter(Boolean).join(' '),
      last,
    });
  }

  // "D Bhushan" - a lone leading letter is far more often a father's or
  // village initial than a given name, so the word after it is the given
  // name. The plain split stays primary because "J Smith" usually means J is
  // the given initial; the caller's format ranking settles which reading an
  // actual address supports.
  if (/^\p{Script=Latin}$/u.test(first)) {
    const given = words[1];
    const family = words.length > 2 ? last : first;
    const between = words.length > 2 ? words.slice(2, -1).join(' ') : '';
    alternatives.push({ first: given, middle: between, last: family });
  }

  return {
    ok: true,
    first,
    middle,
    last,
    alternatives,
    // Three or more words is usually first/middle/last, but it is also how
    // a compound surname arrives, so the split is a guess worth flagging.
    confidence: (words.length > 3 || reversed) ? 'ambiguous' : 'clean',
    reason: null,
  };
}

/**
 * Every reading of a name, best first - the main split followed by any
 * alternative spellings. Callers that want to try harder can predict
 * against all of them.
 */
export function nameReadings(raw) {
  const parsed = parseName(raw);
  if (!parsed.ok) return [];
  return [
    { first: parsed.first, middle: parsed.middle, last: parsed.last },
    ...parsed.alternatives,
  ];
}

export const NAME_REASON_LABELS = {
  no_name: 'No name found in this row',
  single_word_name: 'Only one word - we need a first and last name',
};
