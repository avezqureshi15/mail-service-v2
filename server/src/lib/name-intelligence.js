/**
 * The two jobs a language model is genuinely better at than rules.
 *
 *  1. **Which word is the family name.** Rules take the last token, which is
 *     right for most Western names and wrong for a great many others. Chinese
 *     and Korean names put the family name first; South Indian names often
 *     put the given name second, and a leading single letter is usually an
 *     initial for a father's or village name rather than a given name.
 *     "Balla Praveen" read by rules becomes balla.praveen@; the mailbox is
 *     as likely to be praveen.balla@.
 *
 *  2. **Short forms.** Mailboxes shorten long names constantly - Venkatesh
 *     to venkat, Krishnamurthy to krishna, Robert to bob. A static table of
 *     these is endless and always out of date.
 *
 * What it is never asked: what format a company uses, or what an address is.
 * It sees names and returns name parts. Everything between a name and an
 * address stays deterministic, because a model asked to guess a format
 * answers `first.last` with total confidence whether or not it knows.
 *
 * Output is validated, not trusted. Reordering is only accepted when the
 * words come back from the input - a model that invents a name is ignored
 * and the rules stand.
 */

import { env } from '../config/env.js';
import { chatJson, batched, isEnabled } from './llm.js';
import { normaliseName } from './email-patterns.js';
import { parseName } from './parse-name.js';

/**
 * Deliberately terse.
 *
 * The first version of this spelled out the cultural reasoning at length and
 * invited the model to think it through. On a reasoning model that is a
 * trap: splitting three names burned 4,000 reasoning tokens, hit the output
 * ceiling, and returned an empty string - a total failure that looked like
 * a timeout. The same task with the prompt below answers six names cleanly.
 *
 * Rules, not explanations. And an explicit instruction not to deliberate.
 */
export const SYSTEM = `Split each name into parts for an email database.

Reply with JSON only:
{"names":[{"i":0,"given":"","middle":"","family":"","short":[]}]}
One entry per input, "i" matching the number given.

Rules:
- Use only words from the input. Never invent or translate.
- Family name comes FIRST in Chinese, Korean, Japanese, Hungarian and
  Vietnamese names. Indian names are normally given name first.
- A single leading letter is an initial, not a given name: in "D Bhushan",
  Bhushan is the given name and D is the initial. Keep a lone initial in
  "family" so both "given" and "family" are filled.
- A leading multi-letter word such as "Syed" or "Avez" is part of the name,
  not an honorific to remove.
- short = up to 3 common short forms of the given name
  (Venkatesh->venkat, Robert->bob, Abhishek->abhi). [] if none.
- Never output an email address or @.

Answer immediately. Do not think step by step.`;

const WORD = /^[\p{L}\p{M}'.\- ]{1,60}$/u;

/**
 * Keeps a reordering only when the model is rearranging the operator's own
 * words. Anything else is a hallucination and the rules win.
 */
function tokensOf(raw) {
  return new Set(
    String(raw ?? '')
      .split(/[\s,]+/)
      .map(normaliseName)
      .filter(Boolean),
  );
}

function validate(entry, raw) {
  if (!entry || typeof entry !== 'object') return null;

  const given = String(entry.given ?? '').trim();
  const family = String(entry.family ?? '').trim();
  const middle = String(entry.middle ?? '').trim();

  if (!given || !family) return null;
  if (!WORD.test(given) || !WORD.test(family)) return null;
  if (`${given}${family}${middle}`.includes('@')) return null;
  // A one-word name cannot be split; echoing it back as both halves would
  // manufacture a surname out of nothing.
  if (normaliseName(given) === normaliseName(family)) return null;

  // Both parts must be words the operator supplied.
  const supplied = tokensOf(raw);
  const known = (value) => value
    .split(/\s+/)
    .map(normaliseName)
    .filter(Boolean)
    .every((token) => supplied.has(token));

  if (!known(given) || !known(family)) return null;
  if (middle && !known(middle)) return null;

  // Short forms are new strings by definition, so they cannot be checked
  // against the input. They are capped and only ever become lower-ranked
  // extra candidates, so a bad one costs a wasted guess, never the answer.
  const short = Array.isArray(entry.short) ? entry.short : [];
  const shortForms = short
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter((s) => /^[a-z]{2,20}$/.test(s))
    .filter((s) => s !== normaliseName(given))
    .slice(0, 3);

  return { first: given, middle, last: family, shortForms };
}

/**
 * Asks the model about a batch of names.
 *
 * @returns {Promise<Map<string, {first, middle, last, shortForms, swapped}>>}
 *   keyed by the raw name exactly as passed in. Names the model did not
 *   answer for, or answered badly, are simply absent - callers fall back to
 *   the rules.
 */
export async function enrichNames(
  rawNames,
  { chat = null, enabled = isEnabled(), concurrency = env.LLM_CONCURRENCY } = {},
) {
  const out = new Map();

  // An injected chat always runs - that is the test seam. `enabled` is a
  // second, separate seam so the "no model configured" path can be tested
  // on a machine that does have a key, without reaching the network.
  const call = chat ?? (enabled ? chatJson : null);
  if (!call) return out;

  const names = [...new Set(rawNames.map((n) => String(n ?? '').trim()).filter(Boolean))];
  if (names.length === 0) return out;

  const batches = batched(names);

  /** One batch, folded into `out`. Failures leave the rules in charge. */
  const run = async (batch) => {
    const prompt = batch.map((name, i) => `${i}. ${name}`).join('\n');

    // The ceiling has to cover reasoning, not just the answer - this model
    // spends roughly 500 tokens of thinking per name, and running out
    // returns an empty string rather than a partial answer.
    const answer = await call({
      system: SYSTEM,
      user: prompt,
      // Generous on purpose. Reasoning cost per name varies a lot - one
      // batch of five exhausted 6,000 tokens while a batch of ten finished
      // inside 4,900 - and running out returns an empty string rather than
      // a partial answer, losing the whole batch.
      maxTokens: Math.min(48000, 2000 + batch.length * 1400),
    });

    const entries = Array.isArray(answer?.names) ? answer.names
      : Array.isArray(answer) ? answer
        : null;
    if (!entries) return;

    for (const entry of entries) {
      const index = Number(entry?.i);
      if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;

      const raw = batch[index];
      const checked = validate(entry, raw);
      if (!checked) continue;

      const rules = parseName(raw);
      out.set(raw, {
        ...checked,
        // Worth surfacing: the model disagreeing with the rules about which
        // word is the surname is exactly the case this exists for.
        swapped: rules.ok && normaliseName(rules.last) !== normaliseName(checked.last),
      });
    }
  };

  // Batches run concurrently, bounded. Latency is dominated by the model's
  // thinking rather than by payload size, so a long list finishes in about
  // the time of its slowest few batches instead of the sum of all of them.
  const queue = [...batches];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        // eslint-disable-next-line no-await-in-loop
        await run(batch);
      }
    },
  );
  await Promise.all(workers);

  return out;
}

/**
 * Every reading of one name, best first, combining rules and the model.
 *
 * The model's reading leads when it has one, because the cases it is called
 * on are the ones the rules are known to get wrong. The rules' reading is
 * kept behind it rather than discarded - on a plain Western name they agree,
 * and where they disagree the second candidate is the one worth having.
 */
export function readingsFor(raw, enrichment) {
  const primary = [];
  const speculative = [];
  const seen = new Set();

  const add = (list, first, middle, last) => {
    const key = `${normaliseName(first)}|${normaliseName(middle)}|${normaliseName(last)}`;
    if (!first || !last || seen.has(key)) return;
    seen.add(key);
    list.push({ first, middle, last, speculative: list === speculative });
  };

  const model = enrichment?.get?.(String(raw ?? '').trim());
  const rules = parseName(raw);

  // Primary: readings that disagree about the structure of the name. Each
  // one is a real candidate for who this person is.
  if (model) add(primary, model.first, model.middle, model.last);
  if (rules.ok) {
    add(primary, rules.first, rules.middle, rules.last);
    for (const alt of rules.alternatives) add(primary, alt.first, alt.middle, alt.last);
  }

  // Speculative: short forms of a given name we have already settled on.
  // Worth trying, but their existence says nothing about whether the main
  // reading is right - so they must not count towards ambiguity, or every
  // name with a common nickname would be marked uncertain.
  for (const short of model?.shortForms ?? []) {
    add(speculative, short, model.middle, model.last);
    if (rules.ok && normaliseName(rules.first) !== normaliseName(model.first)) {
      add(speculative, short, rules.middle, rules.last);
    }
  }

  return [...primary, ...speculative];
}

/**
 * Which names are worth spending a call on.
 *
 * Rules handle a plain two-word Western name perfectly, so sending those to
 * a model buys nothing and costs latency. The ones that pay are the ones the
 * rules flagged, plus anything carrying a script where word order is not the
 * Western default.
 */
export function needsModel(raw) {
  const parsed = parseName(raw);
  if (!parsed.ok) return parsed.reason === 'single_word_name';
  if (parsed.confidence === 'ambiguous') return true;

  // The rules read a leading Latin single letter as the given name. That is
  // often an initial attached to a father's or village name, so worth a call.
  // Non-Latin scripts stay excluded above: their answer would be a
  // transliteration, which validate() refuses.
  if (/^\p{Script=Latin}$/u.test(parsed.first)) return true;

  // Deliberately NOT flagged: a name written wholly in a non-Latin script.
  // Word order does differ there, but an address needs Latin characters, so
  // the answer would have to be a transliteration - a new string rather than
  // a reordering of the operator's words, which `validate` refuses on
  // purpose. Spending a call to get an answer we would then discard helps
  // nobody. Those rows are reported as unbuildable instead.

  // A long given name is the usual source of a shortened mailbox.
  return normaliseName(parsed.first).length >= 8;
}
