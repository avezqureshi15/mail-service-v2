/**
 * Address formats, and working one out from a known address.
 *
 * The premise the predictor rests on: a company provisions every mailbox
 * from one rule. So a single address whose owner we know reveals the rule,
 * and the rule gives us everyone else at that domain.
 *
 * Everything here is pure string work - no database, no network, no model.
 * A language model is good at splitting a human name into parts (see
 * `parse-name.js`); it is not good at knowing what format a company uses,
 * and asking it would get a confident `first.last` every time. So the model
 * never sees a domain and never emits an address.
 */

/**
 * Flattens a name to the alphabet a local part is built from.
 *
 * Without the accent strip, `García` never equals `garcia` and a perfectly
 * good address scores as a miss. Measured on a real list, this one step is
 * the difference between matching an address and not.
 */
export function normaliseName(value) {
  return String(value ?? '')
    .normalize('NFD')
    // Combining marks left behind by the decomposition.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes, hyphens and spaces never survive into a local part:
    // O'Brien is obrien, van der Berg is vanderberg.
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Reduces whatever the operator pasted to a bare mail domain.
 *
 * Sales people paste what is in front of them - a full URL from a sheet, a
 * `www.` host, sometimes a whole email address. All of those mean the same
 * company, and refusing them would just move the cleanup onto the operator.
 */
export function normaliseDomain(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';

  // Someone pasted an address rather than a domain.
  if (text.includes('@')) text = text.split('@').pop();

  text = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')  // scheme
    .replace(/^www\./, '')                   // www only - never a real mail host
    .split('/')[0]                           // path
    .split('?')[0]                           // query
    .split('#')[0]
    .replace(/:\d+$/, '')                    // port
    .replace(/\.$/, '');                     // trailing dot on an FQDN

  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) ? text : '';
}

/**
 * Consumer mailbox providers, which have no company format at all - the
 * local part is whatever the person chose at signup.
 *
 * Excluding these is correctness, not tidiness. Group three gmail.com
 * addresses as one "company" and the learner concludes gmail.com uses
 * `first.last`, then predicts `john.smith@gmail.com` for every prospect who
 * happens to be on Gmail.
 */
export const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.in', 'hotmail.com',
  'hotmail.co.uk', 'hotmail.co.in', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'yahoo.co.uk', 'ymail.com',
  'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'gmx.com', 'gmx.net', 'mail.com', 'inbox.com', 'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru', 'protonmail.com', 'proton.me', 'tutanota.com',
  'fastmail.com', 'hushmail.com',
  // Common in Indian B2B lists, where this service does most of its sending.
  'rediffmail.com', 'rediff.com', 'sify.com', 'vsnl.net', 'vsnl.com',
  'bsnl.in', 'dataone.in', 'airtelmail.in', 'indiatimes.com',
]);

export function isFreeProvider(domain) {
  return FREE_PROVIDERS.has(normaliseDomain(domain));
}

/**
 * Every format we can build or recognise.
 *
 * A builder returns null when the parts it needs are absent, which is how
 * the middle-initial formats opt out for a two-part name.
 */
const BUILDERS = {
  'first.last': (f, l) => `${f}.${l}`,
  flast: (f, l) => `${f[0]}${l}`,
  first: (f) => f,
  firstlast: (f, l) => `${f}${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  'first_last': (f, l) => `${f}_${l}`,
  'first.l': (f, l) => `${f}.${l[0]}`,
  firstl: (f, l) => `${f}${l[0]}`,
  last: (f, l) => l,
  'last.first': (f, l) => `${l}.${f}`,
  lastf: (f, l) => `${l}${f[0]}`,
  lastfirst: (f, l) => `${l}${f}`,
  'last_first': (f, l) => `${l}_${f}`,
  'f_last': (f, l) => `${f[0]}_${l}`,
  'first-last': (f, l) => `${f}-${l}`,
  fmlast: (f, l, m) => (m ? `${f[0]}${m[0]}${l}` : null),
  firstmlast: (f, l, m) => (m ? `${f}${m[0]}${l}` : null),
  'first.m.last': (f, l, m) => (m ? `${f}.${m[0]}.${l}` : null),
  'f.l': (f, l) => `${f[0]}.${l[0]}`,
  fl: (f, l) => `${f[0]}${l[0]}`,
};

/**
 * Ranked by how often each explains a real address, so that when a seed is
 * ambiguous the first match is the best guess.
 *
 * The order is not invented: it comes from running `backtest-patterns.js`
 * over a real prospect list, where `first.last` explained 74% of addresses,
 * `flast` 19% and `first.l` 5%. Re-run that script on a bigger list and
 * re-order this if the distribution moves.
 */
export const PATTERNS = Object.keys(BUILDERS);

/** Human-readable form for the UI. */
export const PATTERN_LABELS = {
  'first.last': 'priya.nair@',
  flast: 'pnair@',
  first: 'priya@',
  firstlast: 'priyanair@',
  'f.last': 'p.nair@',
  'first_last': 'priya_nair@',
  'first.l': 'priya.n@',
  firstl: 'priyan@',
  last: 'nair@',
  'last.first': 'nair.priya@',
  lastf: 'nairp@',
  lastfirst: 'nairpriya@',
  'last_first': 'nair_priya@',
  'f_last': 'p_nair@',
  'first-last': 'priya-nair@',
  fmlast: 'pknair@',
  firstmlast: 'priyaknair@',
  'first.m.last': 'priya.k.nair@',
  'f.l': 'p.n@',
  fl: 'pn@',
};

/**
 * Some companies put a constant marker in front of every address -
 * `ts-syed-baseer@`, `ext.anna.smith@`. The format underneath is an
 * ordinary one; it just carries a prefix none of the builders produce.
 *
 * Such a format is stored as `"<affix>|<base>"`, e.g. `ts-|first-last`, so
 * it travels through storage, ranking and prediction as a single pattern
 * key with no special-casing anywhere else.
 */
export const AFFIX_SEP = '|';

export function splitPattern(key) {
  const at = String(key ?? '').indexOf(AFFIX_SEP);
  if (at === -1) return { affix: '', base: String(key ?? '') };
  return { affix: key.slice(0, at), base: key.slice(at + 1) };
}

export const hasAffix = (key) => String(key ?? '').includes(AFFIX_SEP);

/**
 * The local part a format produces for these name parts, or null when the
 * format needs something the name does not have.
 */
export function buildLocal(pattern, { first, last, middle = '' } = {}) {
  const { affix, base } = splitPattern(pattern);
  if (affix) {
    const inner = buildLocal(base, { first, last, middle });
    return inner ? `${affix}${inner}` : null;
  }

  const builder = BUILDERS[pattern];
  if (!builder) return null;

  const f = normaliseName(first);
  const l = normaliseName(last);
  const m = normaliseName(middle);

  // Every format uses at least one of the two, and a one-letter initial of
  // an empty string would throw.
  if (!f || !l) return null;

  const local = builder(f, l, m);
  return local || null;
}

/** The full address a format produces, or null. */
export function buildEmail(pattern, parts, domain) {
  const local = buildLocal(pattern, parts);
  const host = normaliseDomain(domain);
  if (!local || !host) return null;
  return `${local}@${host}`;
}

/**
 * Every format that reproduces this address for this person - the reverse
 * step, and the heart of the feature.
 *
 * Returning more than one is a real outcome rather than a failure: short
 * names and shared initials genuinely collide, and picking one arbitrarily
 * would hide a coin flip behind a confident answer. Returning none means the
 * company uses something outside the set - an employee number, a nickname,
 * a truncation rule - and the honest response is to say so.
 *
 * Results come back in PATTERNS order, so `[0]` is the best guess.
 */
export function matchPatterns(email, parts) {
  const address = String(email ?? '').trim().toLowerCase();
  const [local, domain] = address.split('@');
  if (!local || !domain) return [];

  return PATTERNS.filter((pattern) => buildLocal(pattern, parts) === local);
}

// Learning a domain's format from a seed lives in `predictor.js`, as
// `patternsFromSeed`. It needs every reading of the owner's name, which
// means `name-intelligence.js`, which imports this file - so it cannot live
// here without a cycle. There was briefly a simpler version here that used
// only the plain last-token split; having two learners write to the same
// table is what made "D Bhushan" teach `first` or `last` depending on which
// ran last.

/**
 * Applies known formats to a person, best guess first.
 *
 * Several candidates come back when the seed was ambiguous; the caller
 * decides how much of that to show.
 */
export function predict({ patterns, first, last, middle = '', domain }) {
  const host = normaliseDomain(domain);
  const out = [];

  for (const pattern of patterns) {
    const email = buildEmail(pattern, { first, last, middle }, host);
    // A format the name cannot satisfy - `fmlast` with no middle name - is
    // skipped rather than reported as a failure.
    if (email && !out.some((c) => c.email === email)) {
      out.push({ email, pattern });
    }
  }

  return out;
}

/**
 * Orders a domain's stored formats, best first, and drops the ones it has
 * disproved.
 *
 * Pure, and deliberately kept out of the repository that reads these rows:
 * importing that module opens a connection pool, which a test of a pure
 * function has no business doing - and did, until the suite started
 * exhausting the connection pooler.
 *
 * Evidence decides and the global prior only breaks ties. Sorting on the
 * prior alone means a format proven by ten deliveries loses to one a seed
 * merely asserted, which silently switches the learning off.
 *
 * @param {Array<{pattern: string, provenance: string,
 *                confirmed_count: number, rejected_count: number}>} rows
 * @returns {string[]}
 */
export function usablePatterns(rows) {
  const priority = (pattern) => {
    const at = PATTERNS.indexOf(pattern);
    return at === -1 ? PATTERNS.length : at;
  };

  return rows
    // Disproved twice with nothing to its credit: this company does not
    // use it, and offering it again sends the operator back down a road
    // already known to be closed.
    .filter((row) => !(row.rejected_count >= 2 && row.confirmed_count === 0))
    // Prefixed formats are used from the first seed like any other. The
    // doubt about whether `ts-` is company-wide or marks one person is
    // carried in the confidence band, and bounded by the rollout gate -
    // which releases a single person for an unconfirmed company anyway.
    .sort((a, b) => {
      const proven = (b.provenance === 'proven') - (a.provenance === 'proven');
      if (proven !== 0) return proven;

      const net = (b.confirmed_count - b.rejected_count)
        - (a.confirmed_count - a.rejected_count);
      if (net !== 0) return net;

      if (b.confirmed_count !== a.confirmed_count) return b.confirmed_count - a.confirmed_count;

      return priority(a.pattern) - priority(b.pattern);
    })
    .map((row) => row.pattern);
}

/**
 * Looks for an ordinary format hiding behind a constant marker.
 *
 * `ts-syed-baseer` is `first-last` with `ts-` in front. The matcher refuses
 * it outright, which reads as "we could not parse this" when in fact the
 * format was recognised perfectly and only the prefix was unfamiliar.
 *
 * Finding one is not the same as trusting it. From a single address there
 * is no way to tell a company-wide prefix from a marker on one person -
 * `ts` could mean every Rakuten mailbox or it could mean contractor - and
 * assuming the former would prefix every colleague wrongly. The caller
 * decides; this only reports what it sees.
 *
 * Prefixes only. A trailing marker is rare enough not to justify the extra
 * false-positive surface.
 *
 * @returns {{affix: string, base: string, pattern: string}|null}
 */
export function detectAffix(email, readings = []) {
  const local = String(email ?? '').trim().toLowerCase().split('@')[0];
  if (!local) return null;

  for (const pattern of PATTERNS) {
    for (const reading of readings) {
      const inner = buildLocal(pattern, reading);
      if (!inner || inner.length >= local.length) continue;
      if (!local.endsWith(inner)) continue;

      const affix = local.slice(0, local.length - inner.length);
      // A real marker is a short code closed by a separator: ts-, ext., c_.
      // Without that bound, any address ending in the surname "matches" and
      // a prefix gets invented out of whatever came before it.
      if (!/^[a-z0-9]{1,4}[._-]$/.test(affix)) continue;

      // And it is never part of the person's own name. `anna.smith` would
      // otherwise read as the prefix `anna.` on the format `last`, which
      // is both wrong and confident - it would then prefix every colleague
      // with this one person's given name.
      const core = affix.slice(0, -1);
      const tokens = [reading.first, reading.middle, reading.last]
        .flatMap((value) => String(value ?? '').split(/\s+/))
        .map(normaliseName)
        .filter(Boolean);
      if (tokens.some((token) => token.startsWith(core) || core.startsWith(token))) continue;

      return { affix, base: pattern, pattern: `${affix}${AFFIX_SEP}${pattern}` };
    }
  }
  return null;
}

/**
 * How much to trust a prediction.
 *
 * Three things can each be wrong independently, so they multiply: the
 * format might not be this company's, the format might be one of several
 * that fitted the seed, and the name might have been split wrongly.
 *
 * The weights are deliberately coarse. A backtest over a real list put the
 * overall hit rate near 85%, on a sample far too small to justify tuning
 * these to two decimal places - and the band is what the operator acts on,
 * not the number behind it. Re-run `backtest-patterns.js` on a bigger list
 * before touching them.
 */
const PROVENANCE_WEIGHT = { proven: 1, asserted: 0.85 };
const NAME_WEIGHT = { clean: 1, ambiguous: 0.75 };

export function scoreConfidence({
  provenance = 'asserted',
  patternCount = 1,
  nameConfidence = 'clean',
  // The format was not read directly off the seed - a constant prefix was
  // inferred from what the templates could not account for. That is a
  // genuinely weaker claim than seeing `priya.nair@` and recognising it,
  // and it stops being a guess the moment a delivery confirms it.
  inferred = false,
} = {}) {
  const byProvenance = PROVENANCE_WEIGHT[provenance] ?? PROVENANCE_WEIGHT.asserted;
  const byName = NAME_WEIGHT[nameConfidence] ?? NAME_WEIGHT.ambiguous;
  const byInference = inferred && provenance !== 'proven' ? 0.8 : 1;

  // One format fitting the seed is the happy case; several means the top
  // pick is a ranked guess among plausible siblings.
  let byMatches = 1;
  if (patternCount === 2) byMatches = 0.75;
  else if (patternCount >= 3) byMatches = 0.55;

  const score = Math.round(byProvenance * byName * byMatches * byInference * 100) / 100;

  // Shown to the operator as a word. A percentage would imply a precision
  // this does not have.
  //
  // The top band is reserved for delivery proof: a single asserted seed
  // scores 0.85 and must not claim it, or one mistyped seed looks as good
  // as a confirmed format.
  let band = 'low';
  if (score >= 0.9) band = 'high';
  else if (score >= 0.6) band = 'medium';

  return { score, band };
}

export const BAND_LABELS = {
  high: 'Send normally',
  medium: 'Check the alternatives, send a small batch first',
  low: 'Treat as a guess - do not send unattended',
};

export const SEED_REASON_LABELS = {
  malformed: 'Not a valid email address',
  free_provider: 'Personal mailbox (Gmail, Yahoo and similar) - these have no company format',
  role_account: 'Shared mailbox (info@, sales@ and similar) - these follow no personal format',
  disposable_domain: 'Throwaway mailbox provider',
  seed_owner_name_missing: 'We need the name of the person this address belongs to',
  no_pattern_matched: 'This address does not match any format we recognise',
  hard_bounced: 'This address hard bounced previously, so it does not work',
  suppressed_invalid: 'This address is on the suppression list as invalid',
  no_mx: 'This domain does not receive mail',
};

/**
 * Said when a prefix was deduced rather than read.
 *
 * Worth saying out loud: every other format is visible in the seed itself,
 * where this one is inferred from the part the templates could not account
 * for. The operator should know which kind of claim they are looking at,
 * and that the first send is what settles it.
 */
export function affixMessage({ affix, base, domain }) {
  return `Read as "${affix}" in front of ${base}. The prefix was deduced from the one `
    + `address you gave, so it is not yet known whether every mailbox at ${domain} carries `
    + `it or whether it marks just that person - the first send will say. Predictions here `
    + `are marked a band lower until one lands.`;
}
