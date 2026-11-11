/**
 * Turning a list of names into addresses, given what we know about each
 * company's format.
 *
 * Deliberately free of database and network calls: the caller loads every
 * domain's formats in one query and hands them in as a Map. That is what
 * keeps a bulk run to a handful of round trips no matter how many rows it
 * has - the expensive work is per company, and there are far fewer
 * companies than people.
 */

import {
  normaliseDomain, normaliseName, predict, scoreConfidence,
  matchPatterns, isFreeProvider, detectAffix, hasAffix, PATTERNS,
} from './email-patterns.js';
import { parseName } from './parse-name.js';
import { readingsFor } from './name-intelligence.js';

// Formats that write out the whole given name. If the reading says the given
// name is a lone letter, these are usually the mis-split, not the answer;
// formats that deliberately use the given initial (flast, f.last, ...) are
// unaffected.
// `fmlast` is deliberately absent: it builds `f[0] + m[0] + last`, so it is
// one of the initial formats this rule is meant to leave alone. Including it
// demoted perfectly good candidates like rkkarthik@ for "R K Karthik".
const FULL_GIVEN_PATTERNS = new Set([
  'first', 'first.last', 'firstlast', 'first_last', 'first-last',
  'first.m.last', 'firstmlast',
]);

export const SKIP_LABELS = {
  no_domain: 'No company website on this row',
  no_format: 'We do not know this company\'s format yet - give us one working address there',
  no_name: 'No name on this row',
  single_word_name: 'Only one word - we need a first and last name',
  unbuildable: 'This name cannot be written in the format this company uses',
  suppressed: 'This address has unsubscribed, bounced or been suppressed - it cannot be mailed',
};

/**
 * @param {Array<{name: string, domain: string, [key: string]: any}>} rows
 * @param {Map<string, {patterns: string[], provenance: string}>} knowledge
 * @param {{enrichment?: Map}} [options] - model readings from
 *   `name-intelligence.js`, keyed by raw name. Absent means rules only,
 *   which is the supported default rather than a degraded mode.
 * @returns {{results: object[], skipped: object[]}}
 */
export function predictRows(rows, knowledge, { enrichment = null } = {}) {
  const results = [];
  const skipped = [];

  for (const row of rows) {
    const domain = normaliseDomain(row.domain);
    const name = String(row.name ?? '').trim();

    if (!domain) {
      skipped.push({ ...row, reason: 'no_domain' });
      continue;
    }

    const known = knowledge.get(domain);
    if (!known || known.patterns.length === 0) {
      skipped.push({ ...row, domain, reason: 'no_format' });
      continue;
    }

    const parsed = parseName(name);
    if (!parsed.ok) {
      skipped.push({ ...row, domain, reason: parsed.reason });
      continue;
    }

    // Every plausible reading of the name crossed with every format the
    // company might use. A nickname or an initials reading often supplies
    // the candidate the main split cannot reach.
    const candidates = [];
    for (const reading of readingsFor(name, enrichment)) {
      for (const candidate of predict({ patterns: known.patterns, ...reading, domain })) {
        if (!candidates.some((c) => c.email === candidate.email)) {
          candidates.push({
            ...candidate,
            speculative: reading.speculative === true,
            // "D Bhushan" read with given=D would make d@ the top answer
            // even when bhushan@ is sitting right behind it. Formats that
            // use the whole given name should not lead with a lone initial.
            givenIsInitial: FULL_GIVEN_PATTERNS.has(candidate.pattern)
              && normaliseName(reading.first).length === 1,
          });
        }
      }
    }

    if (candidates.length === 0) {
      skipped.push({ ...row, domain, reason: 'unbuildable' });
      continue;
    }

    // Stable sort: readings keep their order except that an initial-as-given
    // reading is pushed behind any real given-name reading.
    candidates.sort((a, b) => Number(a.givenIsInitial) - Number(b.givenIsInitial));

    // Ambiguity counts only the candidates that represent a genuinely
    // different answer - several formats fitting the seed, or the name
    // reading more than one way. Short forms of a given name we have
    // already settled on are extras worth trying, not doubt about the main
    // answer; counting them would mark every Robert and every Venkatesh
    // uncertain purely because nicknames exist.
    const ambiguity = candidates.filter((c) => !c.speculative).length || 1;

    const [best, ...rest] = candidates;

    const { score, band } = scoreConfidence({
      provenance: known.provenance,
      patternCount: ambiguity,
      nameConfidence: parsed.confidence,
      // A prefix was inferred rather than read off the seed, so the claim
      // is weaker until a delivery settles it.
      inferred: hasAffix(best.pattern),
    });
    results.push({
      ...row,
      domain,
      inputName: name,
      firstName: parsed.first,
      middleName: parsed.middle,
      lastName: parsed.last,
      email: best.email,
      // `format` is the answer to "which part of the name is used"; `pattern`
      // is kept for the existing callers that already read it.
      pattern: best.pattern,
      format: best.pattern,
      formatEvidence: known.provenance === 'proven'
        ? 'delivery'
        : known.patterns.length > 1 ? 'ambiguous-seed' : 'single-seed',
      nameSource: enrichment?.has?.(name) ? 'model' : 'rules',
      nameConfidence: parsed.confidence,
      // What drove the band: one plausible answer, or several. Persisted so
      // a later bounce can be charged to the reading or to the format
      // rather than guessed at.
      readingCount: ambiguity,
      alternatives: rest,
      score,
      band,
    });
  }

  return { results, skipped };
}

/**
 * Learns a company's formats from one address whose owner is known.
 *
 * The single place this is worked out. There used to be two - the route
 * read the owner's name through every reading, while the contacts backfill
 * used the plain last-token split - so "D Bhushan" with bhushan@ taught
 * `first` through one path and `last` through the other, into the same
 * table, with whichever ran last winning.
 *
 * Structural checks only. Whether the address is a role account, is on the
 * suppression list, or has ever bounced needs the database and belongs to
 * the caller.
 *
 * @param {{email: string, ownerName: string, enrichment?: Map|null}} input
 * @returns {{ok: boolean, reason?: string, domain: string, patterns: string[]}}
 */
export function patternsFromSeed({ email, ownerName, enrichment = null }) {
  const address = String(email ?? '').trim().toLowerCase();
  const domain = normaliseDomain(address);

  if (!domain || !address.includes('@')) {
    return { ok: false, reason: 'malformed', domain: '', patterns: [] };
  }
  if (isFreeProvider(domain)) {
    return { ok: false, reason: 'free_provider', domain, patterns: [] };
  }

  const readings = readingsFor(ownerName, enrichment);
  if (readings.length === 0) {
    return { ok: false, reason: 'seed_owner_name_missing', domain, patterns: [] };
  }

  // Every reading of the owner's name, against the address they actually
  // use. A seed that fits under more than one reading genuinely supports
  // more than one format.
  const matched = new Set();
  for (const reading of readings) {
    for (const pattern of matchPatterns(address, reading)) matched.add(pattern);
  }

  // PATTERNS order is the priority order, so `first` outranks `last` when a
  // seed supports both.
  const patterns = PATTERNS.filter((pattern) => matched.has(pattern));
  if (patterns.length > 0) return { ok: true, domain, patterns };

  // Nothing fits outright. Before giving up, check for an ordinary format
  // behind a constant marker - `ts-syed-baseer` is `first-last` with `ts-`
  // in front, and reporting that as "we do not recognise this" hides the
  // fact that we recognised all of it but three characters.
  const affix = detectAffix(address, readings);
  if (affix) {
    // Used straight away, on one address.
    //
    // It cannot be known from a single seed whether `ts-` marks every
    // mailbox at the company or just this person - but the rollout gate
    // already answers that the only way anyone can: a company nobody has
    // confirmed releases one person, so a wrong prefix costs one bounce
    // and is then demoted. Holding out for a second seed was a second
    // lock on the same door, and it left companies permanently stuck when
    // the operator only ever had one address.
    //
    // The doubt is real, so it is carried in the confidence instead of in
    // a refusal.
    return {
      ok: true,
      domain,
      patterns: [affix.pattern],
      inferredAffix: affix.affix,
      base: affix.base,
    };
  }

  return { ok: false, reason: 'no_pattern_matched', domain, patterns: [] };
}

/**
 * Separates the addresses we may not write to.
 *
 * Done before the rollout gate rather than by flagging rows in place: a
 * suppressed row could otherwise take a probing company's single probe
 * slot and then be hidden by the page, leaving the operator with an empty
 * screen, the company still locked, and nothing to act on.
 *
 * They become skipped rows with a reason instead of disappearing, because
 * "we already know this person unsubscribed" is useful to see.
 *
 * @param {object[]} results
 * @param {Set<string>} suppressed lowercased addresses
 */
export function splitSuppressed(results, suppressed) {
  const mailable = [];
  const blocked = [];

  for (const result of results) {
    if (suppressed.has(result.email)) {
      blocked.push({ ...result, name: result.inputName, reason: 'suppressed' });
    } else {
      mailable.push(result);
    }
  }
  return { mailable, blocked };
}

/**
 * Collapses rows that resolved to the same address.
 *
 * Two spellings of one person - "Mike Chen" and "Michael Chen" on different
 * rows - would otherwise both be offered, and adding both would mail the
 * same mailbox twice from one campaign.
 */
export function dedupeByEmail(results) {
  const seen = new Map();
  for (const result of results) {
    const existing = seen.get(result.email);
    if (!existing || result.score > existing.score) seen.set(result.email, result);
  }
  return [...seen.values()];
}

/** Per-company rollup for the bulk preview. */
export function summariseByDomain(results, skipped) {
  const rollup = new Map();

  const touch = (domain) => {
    if (!rollup.has(domain)) {
      rollup.set(domain, { domain, high: 0, medium: 0, low: 0, skipped: 0, needsSeed: false });
    }
    return rollup.get(domain);
  };

  for (const r of results) touch(r.domain)[r.band] += 1;
  for (const s of skipped) {
    const entry = touch(s.domain || '(no website)');
    entry.skipped += 1;
    if (s.reason === 'no_format') entry.needsSeed = true;
  }

  // Companies needing a seed first: one address unlocks everyone there, so
  // that is where the operator's next minute is best spent.
  return [...rollup.values()].sort((a, b) => {
    if (a.needsSeed !== b.needsSeed) return a.needsSeed ? -1 : 1;
    return (b.high + b.medium + b.low + b.skipped) - (a.high + a.medium + a.low + a.skipped);
  });
}
