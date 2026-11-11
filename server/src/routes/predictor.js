import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';

import {
  knowledgeForDomains, recordPattern, recordPatterns, seedEvidence,
  savePredictions, predictorStats, upsertDomainProfile,
} from '../db/repositories/predictions.js';
import {
  upsertManyContacts, createList, findListByName, addManyToList,
  findByEmail as findContactByEmail,
} from '../db/repositories/contacts.js';
import { suppressedSubset } from '../db/repositories/suppressions.js';
import { logAction } from '../db/repositories/users.js';
import {
  normaliseDomain, isFreeProvider, affixMessage, PATTERN_LABELS,
  SEED_REASON_LABELS, BAND_LABELS,
} from '../lib/email-patterns.js';
import { enrichNames, needsModel } from '../lib/name-intelligence.js';
import { isEnabled as llmEnabled } from '../lib/llm.js';
import {
  predictRows, dedupeByEmail, summariseByDomain, patternsFromSeed,
  splitSuppressed, SKIP_LABELS,
} from '../lib/predictor.js';
import { rolloutStateFor, gateResults, gateByDomain } from '../lib/rollout.js';
import { parseEmail } from '../lib/email-validation.js';
import { hasMx } from '../lib/dns-check.js';
import { requireAuth, validate } from '../middleware/index.js';

export const predictorRouter = Router();
predictorRouter.use(requireAuth);

/**
 * Tighter than the global limit. Predicting addresses is, from the outside,
 * enumerating the staff of a company - worth rationing even for a signed-in
 * operator, and worth capping if an account is ever compromised.
 */
predictorRouter.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many prediction requests - wait a minute and try again.' },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// ---------------------------------------------------------------- helpers

/**
 * Decides whether an address can teach us a company's format, and how much
 * to trust what it teaches.
 *
 * The checks run in order of cost: syntax, then the lists we hold in
 * memory, then our own send history, then DNS last.
 */
async function qualifySeed({ seedEmail, seedOwnerName, tenantId = 1 }, { enrichment = null } = {}) {
  const parsed = parseEmail(seedEmail);
  if (!parsed.ok) return { ok: false, reason: 'malformed' };

  // A shared mailbox follows no personal format, so it has nothing to teach.
  if (parsed.isRole) return { ok: false, reason: 'role_account', domain: parsed.domain };
  if (parsed.isDisposable) return { ok: false, reason: 'disposable_domain', domain: parsed.domain };
  if (isFreeProvider(parsed.domain)) return { ok: false, reason: 'free_provider', domain: parsed.domain };

  // Our own records may flatly contradict the operator.
  const evidence = await seedEvidence(parsed.email, tenantId);
  if (evidence.blocked) return { ok: false, reason: evidence.blocked, domain: parsed.domain };

  // The owner's name must come from the operator or from a contact record -
  // never from reading the address. Inferring "Priya Nair" out of
  // priya.nair@ would assume `first.last` and then learn back the
  // assumption, which is confident nonsense.
  let ownerName = String(seedOwnerName ?? '').trim();
  if (!ownerName) {
    const contact = await findContactByEmail(parsed.email, tenantId);
    const stored = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ');
    if (stored.trim()) ownerName = stored.trim();
  }
  if (!ownerName) return { ok: false, reason: 'seed_owner_name_missing', domain: parsed.domain };

  // One shared learner, also used by the contacts backfill - see
  // `patternsFromSeed`. Reading the owner's name every way predictions do
  // is what keeps a seed like "D Bhushan" with bhushan@ from teaching
  // `last` when the mailbox plainly uses the given name.
  const ownerEnrichment = enrichment ?? await enrichNames([ownerName]);
  const learned = patternsFromSeed({
    email: parsed.email, ownerName, enrichment: ownerEnrichment,
  });
  if (!learned.ok) return { ok: false, reason: learned.reason, domain: parsed.domain };

  const mx = await hasMx(parsed.domain).catch(() => true);
  if (!mx) return { ok: false, reason: 'no_mx', domain: parsed.domain };

  return {
    ok: true,
    domain: parsed.domain,
    patterns: learned.patterns,
    provenance: evidence.provenance,
    // Present when a constant prefix was inferred rather than read off the
    // seed. Surfaced so the page can say so, since it is the one case
    // where the format was deduced from what did not fit.
    inferredAffix: learned.inferredAffix ?? '',
    ownerName,
    seedEmail: parsed.email,
  };
}

/** What we already know about a set of domains, shaped for `predictRows`. */
// Moved into the repository so the lifecycle test exercises the same
// shaping the route does, rather than a copy of it.
const knowledgeFor = knowledgeForDomains;

const describe = (domain, entry) => ({
  domain,
  known: Boolean(entry),
  patterns: entry?.patterns ?? [],
  pattern: entry?.patterns?.[0] ?? null,
  example: entry?.patterns?.[0] ? PATTERN_LABELS[entry.patterns[0]] : null,
  provenance: entry?.provenance ?? null,
  learnedFrom: entry?.learnedFrom ?? '',
});

// ----------------------------------------------------------------- routes

predictorRouter.get('/stats', async (_req, res, next) => {
  try {
    res.json({
      stats: await predictorStats(),
      bandLabels: BAND_LABELS,
      nameModel: llmEnabled(),
    });
  } catch (error) {
    next(error);
  }
});

const domainQuery = z.object({ domain: z.string().trim().min(1).max(255) });

/** "Do we already know this company?" - called as the operator types. */
predictorRouter.post('/domain', validate(domainQuery), async (req, res, next) => {
  try {
    const domain = normaliseDomain(req.body.domain);
    if (!domain) return res.status(400).json({ error: 'That does not look like a website or domain.' });
    if (isFreeProvider(domain)) {
      return res.json({
        ...describe(domain, null),
        blocked: 'free_provider',
        blockedLabel: SEED_REASON_LABELS.free_provider,
      });
    }

    const knowledge = await knowledgeFor([domain]);
    res.json(describe(domain, knowledge.get(domain)));
  } catch (error) {
    next(error);
  }
});

const seedBody = z.object({
  seedEmail: z.string().trim().min(3).max(254),
  seedOwnerName: z.string().trim().max(200).default(''),
});

/** Qualifies a seed and, if it is good, learns the company's format from it. */
predictorRouter.post('/seed', validate(seedBody), async (req, res, next) => {
  try {
    const outcome = await qualifySeed(req.body);
    if (!outcome.ok) {
      return res.status(422).json({
        error: SEED_REASON_LABELS[outcome.reason] ?? 'This address cannot be used as a seed.',
        reason: outcome.reason,
        domain: outcome.domain ?? '',
      });
    }

    await upsertDomainProfile({ domain: outcome.domain, hasMx: true });
    for (const pattern of outcome.patterns) {
      await recordPattern({
        domain: outcome.domain,
        pattern,
        provenance: outcome.provenance,
        learnedFrom: outcome.seedEmail,
      });
    }
    await logAction({
      userId: req.user.id, action: 'predictor.seed', entity: 'domain', entityId: null,
    });

    const knowledge = await knowledgeFor([outcome.domain]);
    res.json({
      ...describe(outcome.domain, knowledge.get(outcome.domain)),
      learnedNow: true,
      affixNote: outcome.inferredAffix
        ? affixMessage({ affix: outcome.inferredAffix, base: outcome.base ?? '', domain: outcome.domain })
        : '',
      ownerName: outcome.ownerName,
    });
  } catch (error) {
    next(error);
  }
});

const predictBody = z.object({
  domain: z.string().trim().min(1).max(255),
  names: z.array(z.string().trim().max(300)).min(1).max(500),
  seedEmail: z.string().trim().max(254).default(''),
  seedOwnerName: z.string().trim().max(200).default(''),
  // Ask the model about every name rather than only the flagged ones.
  // Slower, and worth it on a list of non-Western names.
  checkAllNames: z.coerce.boolean().default(false),
  // How many people to release for a company whose format nothing has
  // confirmed yet. The operator can raise it; one is the safe default.
  probeBudget: z.coerce.number().int().min(1).max(50).default(1),
});

/** One company, many people - the main path. */
predictorRouter.post('/predict', validate(predictBody), async (req, res, next) => {
  try {
    const { names, seedEmail, seedOwnerName } = req.body;
    const domain = normaliseDomain(req.body.domain);
    if (!domain) return res.status(400).json({ error: 'That does not look like a website or domain.' });

    let knowledge = await knowledgeFor([domain]);
    let learnedNow = false;
    let affixNote = '';

    // Only bother with the seed if we cannot already answer - a company we
    // know needs nothing from the operator.
    if (!knowledge.has(domain) && seedEmail) {
      const outcome = await qualifySeed({ seedEmail, seedOwnerName });
      if (!outcome.ok) {
        return res.status(422).json({
          error: SEED_REASON_LABELS[outcome.reason] ?? 'This address cannot be used as a seed.',
          reason: outcome.reason,
        });
      }
      if (outcome.domain !== domain) {
        return res.status(422).json({
          error: `That address is at ${outcome.domain}, not ${domain}.`,
          reason: 'seed_domain_mismatch',
        });
      }
      for (const pattern of outcome.patterns) {
        await recordPattern({
          domain, pattern, provenance: outcome.provenance, learnedFrom: outcome.seedEmail,
        });
      }
      await upsertDomainProfile({ domain, hasMx: true });
      knowledge = await knowledgeFor([domain]);
      learnedNow = true;
      if (outcome.inferredAffix) {
        affixNote = affixMessage({
          affix: outcome.inferredAffix, base: outcome.base ?? '', domain,
        });
      }
    }

    const rows = names.filter(Boolean).map((name) => ({ name, domain }));

    // The model costs about 2.5 seconds per name (measured), so who gets
    // asked matters.
    //
    // By default only the names the rules flag. `checkAllNames` is the
    // operator's override for a list where word order is the issue: the
    // rules see "Balla Praveen" as a clean two-word name, and only the
    // model knows Praveen is the given name. They know which list they have
    // and whether the wait is worth it; we cannot tell from the rows.
    const toCheck = req.body.checkAllNames
      ? rows.map((r) => r.name).slice(0, 40)
      : rows.map((r) => r.name).filter(needsModel);
    const enrichment = await enrichNames(toCheck);
    const { results, skipped } = predictRows(rows, knowledge, { enrichment });
    const unique = dedupeByEmail(results);

    // Never hand back an address the operator may not write to.
    //
    // Separated *before* gating, not flagged in place: a suppressed row
    // used to be able to take the single probe slot and then be hidden by
    // the page, leaving the operator with nothing on screen, the company
    // still locked, and no way forward.
    const suppressed = await suppressedSubset(unique.map((r) => r.email));
    const { mailable, blocked } = splitSuppressed(unique, suppressed);

    // A format nothing has confirmed is a claim. Hand over one person,
    // let the outcome arrive, then release the rest - fifty addresses
    // built on a wrong claim is fifty bounces through the mailbox
    // provider that is already this service's tightest constraint.
    const state = rolloutStateFor(knowledge.get(domain)?.rows ?? []);
    const { revealed, rollout } = gateResults({
      results: mailable,
      state,
      probeBudget: req.body.probeBudget,
      domain,
    });

    // Only what was handed over is recorded. Storing the held-back rows
    // too would leave predictions nobody was ever shown, which a later
    // bounce could then be attributed to.
    if (revealed.length > 0) {
      await savePredictions(
        revealed.map((r) => ({
          domain: r.domain,
          input_name: r.inputName,
          first_name: r.firstName,
          middle_name: r.middleName,
          last_name: r.lastName,
          predicted_email: r.email,
          pattern: r.pattern,
          confidence: r.score,
          band: r.band,
          name_confidence: r.nameConfidence,
          name_source: r.nameSource,
          reading_count: r.readingCount,
          seed_email: seedEmail ?? '',
        })),
        { userId: req.user.id },
      );
    }

    res.json({
      ...describe(domain, knowledge.get(domain)),
      learnedNow,
      affixNote,
      namesEnriched: enrichment.size,
      rollout,
      results: revealed,
      skipped: [...skipped, ...blocked]
        .map((s) => ({ ...s, label: SKIP_LABELS[s.reason] ?? s.reason })),
    });
  } catch (error) {
    next(error);
  }
});

const saveBody = z.object({
  contacts: z.array(z.object({
    email: z.string().trim().email(),
    firstName: z.string().trim().max(100).default(''),
    lastName: z.string().trim().max(100).default(''),
    company: z.string().trim().max(200).default(''),
    customFields: z.record(z.string()).default({}),
  })).min(1).max(5000),
  listName: z.string().trim().max(120).default(''),
  listId: z.coerce.number().int().positive().optional(),
});

/** Writes accepted predictions into contacts, and optionally into a list. */
predictorRouter.post('/save', validate(saveBody), async (req, res, next) => {
  try {
    const { contacts, listName, listId } = req.body;

    const ids = await upsertManyContacts(
      contacts.map((c) => ({ ...c, source: 'predicted' })),
    );

    let list = null;
    if (listId) {
      list = { id: listId };
    } else if (listName) {
      list = await findListByName(listName) ?? await createList({
        name: listName,
        description: 'Created by the Mail Predictor',
        createdBy: req.user.id,
      });
    }
    if (list?.id) await addManyToList(list.id, ids);

    await logAction({
      userId: req.user.id, action: 'predictor.save', entity: 'contact', entityId: null,
    });

    res.status(201).json({ saved: ids.length, listId: list?.id ?? null });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------------ bulk

const HEADER_ALIASES = {
  company_domain: ['company_domain', 'domain', 'website', 'company_website', 'url'],
  person_name: ['person_name', 'name', 'full_name', 'contact_name', 'person_of_contact'],
  seed_email: ['seed_email', 'known_email', 'seed', 'email'],
  seed_person_name: ['seed_person_name', 'seed_name', 'seed_owner', 'known_email_owner'],
  company_name: ['company_name', 'company', 'organisation', 'organization'],
  observation: ['observation'],
  role_examples: ['role_examples', 'roles'],
};

function pick(row, field) {
  const keys = HEADER_ALIASES[field] ?? [field];
  for (const key of keys) {
    const found = Object.keys(row).find(
      (k) => k.trim().toLowerCase().replace(/[\s-]+/g, '_') === key,
    );
    if (found && String(row[found] ?? '').trim()) return String(row[found]).trim();
  }
  return '';
}

/**
 * A whole file at once.
 *
 * Spreadsheet exports routinely carry the company on the first row of a
 * block and leave it blank beneath, so both the domain and the seed are
 * carried forward within a run of rows for the same company. Repeating
 * them on every row works equally well.
 */
predictorRouter.post('/bulk', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    let records;
    try {
      records = parseCsv(req.file.buffer.toString('utf8'), {
        columns: true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true,
      });
    } catch {
      return res.status(400).json({
        error: 'Could not read that file. Save the template as CSV and upload that.',
      });
    }
    if (records.length === 0) return res.status(400).json({ error: 'That file has no rows.' });
    if (records.length > 20000) {
      return res.status(413).json({ error: 'That file has more than 20,000 rows. Split it up.' });
    }

    let lastDomain = '';
    const rows = records.map((record) => {
      const domain = normaliseDomain(pick(record, 'company_domain'));
      if (domain) lastDomain = domain;
      return {
        name: pick(record, 'person_name'),
        domain: domain || lastDomain,
        company: pick(record, 'company_name'),
        seedEmail: pick(record, 'seed_email'),
        seedOwnerName: pick(record, 'seed_person_name'),
        observation: pick(record, 'observation'),
        roleExamples: pick(record, 'role_examples'),
      };
    });

    // One seed per company is all we need, so collect the first usable one
    // for each domain and qualify that - not one per row.
    const seedByDomain = new Map();
    for (const row of rows) {
      if (row.domain && row.seedEmail && !seedByDomain.has(row.domain)) {
        seedByDomain.set(row.domain, { seedEmail: row.seedEmail, seedOwnerName: row.seedOwnerName });
      }
    }

    const domains = [...new Set(rows.map((r) => r.domain).filter(Boolean))];
    let knowledge = await knowledgeFor(domains);

    // Enrich every unknown seed owner in one batch, so a file spanning many
    // new companies costs one model call rather than one per company.
    const unknownSeedOwners = [...seedByDomain]
      .filter(([domain]) => !knowledge.has(domain))
      .map(([, seed]) => seed.seedOwnerName)
      .filter(Boolean);
    const seedEnrichment = unknownSeedOwners.length > 0
      ? await enrichNames(unknownSeedOwners)
      : new Map();

    const learned = [];
    const rejectedSeeds = [];
    for (const [domain, seed] of seedByDomain) {
      if (knowledge.has(domain)) continue;
      const outcome = await qualifySeed(seed, { enrichment: seedEnrichment });
      if (!outcome.ok || outcome.domain !== domain) {
        rejectedSeeds.push({
          domain,
          seedEmail: seed.seedEmail,
          reason: outcome.reason ?? 'seed_domain_mismatch',
          label: SEED_REASON_LABELS[outcome.reason] ?? 'This seed could not be used.',
        });
        continue;
      }
      for (const pattern of outcome.patterns) {
        learned.push({
          domain, pattern, provenance: outcome.provenance, learnedFrom: outcome.seedEmail,
        });
      }
    }
    if (learned.length > 0) {
      await recordPatterns(learned);
      knowledge = await knowledgeFor(domains);
    }

    const enrichment = await enrichNames(rows.map((r) => r.name).filter(needsModel));
    const { results, skipped } = predictRows(rows, knowledge, { enrichment });
    const unique = dedupeByEmail(results);
    // Same as the single-company path: a suppressed row must not consume a
    // company's probe budget and then be hidden by the page.
    const suppressed = await suppressedSubset(unique.map((r) => r.email));
    const { mailable, blocked } = splitSuppressed(unique, suppressed);

    // Each company on its own state: a file mixing companies we have
    // delivered to with brand-new ones should hand over the former in full
    // and probe the latter, rather than treating the whole upload alike.
    const stateByDomain = new Map(
      domains.map((d) => [d, rolloutStateFor(knowledge.get(d)?.rows ?? [])]),
    );
    const { revealed, rollouts } = gateByDomain(
      mailable, stateByDomain, Number(req.body?.probeBudget) || 1,
    );

    // Bulk was not recording its predictions at all, so a bounce on an
    // uploaded address had no format to attribute itself to and the
    // feedback loop simply never closed for this path.
    if (revealed.length > 0) {
      await savePredictions(
        revealed.map((r) => ({
          domain: r.domain,
          input_name: r.inputName,
          first_name: r.firstName,
          middle_name: r.middleName,
          last_name: r.lastName,
          predicted_email: r.email,
          pattern: r.pattern,
          confidence: r.score,
          band: r.band,
          name_confidence: r.nameConfidence,
          name_source: r.nameSource,
          reading_count: r.readingCount,
          seed_email: r.seedEmail ?? '',
        })),
        { userId: req.user.id },
      );
    }

    res.json({
      namesEnriched: enrichment.size,
      rows: records.length,
      companies: domains.length,
      companiesLearned: new Set(learned.map((l) => l.domain)).size,
      probing: rollouts.length,
      heldBack: rollouts.reduce((n, r) => n + r.heldPeople, 0),
      rollouts: rollouts.slice(0, 50),
      results: revealed,
      skipped: [...skipped, ...blocked]
        .map((s) => ({ ...s, label: SKIP_LABELS[s.reason] ?? s.reason })),
      rejectedSeeds,
      byCompany: summariseByDomain(revealed, [...skipped, ...blocked]),
    });
  } catch (error) {
    next(error);
  }
});
