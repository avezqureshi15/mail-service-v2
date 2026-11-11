import { query, queryOne, execute } from '../index.js';
import { normaliseDomain, usablePatterns as usablePatternsOf } from '../../lib/email-patterns.js';

/**
 * Storage for the Mail Predictor.
 *
 * Every read here is batched by design. A bulk run covering 5,000 rows
 * across 400 companies must cost a handful of round trips, not one per row,
 * so the shapes below take arrays and use `= ANY($1)` rather than being
 * called in a loop. That is the single property keeping a large upload fast.
 */

const lower = (value) => String(value ?? '').trim().toLowerCase();

// --------------------------------------------------------------- patterns

/**
 * Known formats for many domains at once.
 *
 * @returns {Promise<Map<string, object[]>>} domain -> rows, best first
 */
export async function patternsForDomains(domains, tenantId = 1) {
  const out = new Map();

  const wanted = [...new Set(domains.map(normaliseDomain))].filter(Boolean);
  if (wanted.length === 0) return out;

  const rows = await query(
    `SELECT lower(domain) AS domain, pattern, provenance,
            confirmed_count, rejected_count, learned_from, last_evidence_at
       FROM domain_patterns
      WHERE tenant_id = $1 AND lower(domain) = ANY($2::text[])
      ORDER BY provenance DESC,
               (confirmed_count - rejected_count) DESC,
               confirmed_count DESC`,
    [tenantId, wanted],
  );

  for (const row of rows) {
    if (!out.has(row.domain)) out.set(row.domain, []);
    out.get(row.domain).push(row);
  }
  return out;
}

export async function patternsForDomain(domain, tenantId = 1) {
  const map = await patternsForDomains([domain], tenantId);
  return map.get(normaliseDomain(domain)) ?? [];
}

// Pure, so it lives in `lib/email-patterns.js`; re-exported here because
// this is where callers expect to find it alongside the rows it ranks.
export { usablePatterns } from '../../lib/email-patterns.js';

/**
 * What we know about a set of domains, in the shape `predictRows` and
 * `rolloutStateFor` consume.
 *
 * Lives here rather than in the route so that a test can exercise the same
 * code the route runs. Reimplementing this shaping in a test would let the
 * test pass while the route was broken, which is the opposite of useful.
 *
 * Domains with no usable format are absent rather than present-and-empty,
 * so callers can treat a miss as "we do not know this company".
 *
 * @returns {Promise<Map<string, {patterns: string[], provenance: string,
 *   learnedFrom: string, rows: object[]}>>}
 */
export async function knowledgeForDomains(domains, tenantId = 1) {
  const stored = await patternsForDomains(domains, tenantId);
  const knowledge = new Map();

  for (const [domain, rows] of stored) {
    const patterns = usablePatternsOf(rows);
    if (patterns.length === 0) continue;
    knowledge.set(domain, {
      patterns,
      provenance: rows.some((r) => r.provenance === 'proven') ? 'proven' : 'asserted',
      learnedFrom: rows[0]?.learned_from ?? '',
      // Carried through so the rollout state can be derived rather than
      // stored - the counts are the only input it needs.
      rows,
    });
  }
  return knowledge;
}

/**
 * Records a format for a domain.
 *
 * Re-asserting something already proven must not demote it, hence the
 * GREATEST on provenance - 'proven' sorts above 'asserted'.
 */
export async function recordPattern({
  domain, pattern, provenance = 'asserted', learnedFrom = '', tenantId = 1,
}) {
  const host = normaliseDomain(domain);
  if (!host || !pattern) return false;

  const changed = await execute(
    `INSERT INTO domain_patterns (tenant_id, domain, pattern, provenance, learned_from, last_evidence_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, lower(domain), pattern) DO UPDATE
        SET provenance   = GREATEST(domain_patterns.provenance, EXCLUDED.provenance),
            -- Only a *different* address counts as a second opinion.
            -- Pasting the same seed twice must not let a prefix confirm
            -- itself, which is the whole point of requiring two.
            asserted_count = domain_patterns.asserted_count
              + CASE WHEN EXCLUDED.learned_from <> ''
                      AND domain_patterns.learned_from <> EXCLUDED.learned_from
                     THEN 1 ELSE 0 END,
            learned_from = CASE WHEN domain_patterns.learned_from = ''
                                THEN EXCLUDED.learned_from
                                ELSE domain_patterns.learned_from END`,
    [tenantId, host, pattern, provenance, lower(learnedFrom)],
  );
  return changed > 0;
}

/** One statement for every (domain, pattern) a bulk run learned. */
export async function recordPatterns(entries, tenantId = 1) {
  const rows = entries
    .map((e) => ({ ...e, domain: normaliseDomain(e.domain) }))
    .filter((e) => e.domain && e.pattern);
  if (rows.length === 0) return 0;

  return execute(
    `INSERT INTO domain_patterns (tenant_id, domain, pattern, provenance, learned_from, last_evidence_at)
     SELECT $1, d, p, v, l, now()
       FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[]) AS t(d, p, v, l)
     ON CONFLICT (tenant_id, lower(domain), pattern) DO UPDATE
        SET provenance = GREATEST(domain_patterns.provenance, EXCLUDED.provenance),
            asserted_count = domain_patterns.asserted_count
              + CASE WHEN EXCLUDED.learned_from <> ''
                      AND domain_patterns.learned_from <> EXCLUDED.learned_from
                     THEN 1 ELSE 0 END`,
    [
      tenantId,
      rows.map((r) => r.domain),
      rows.map((r) => r.pattern),
      rows.map((r) => r.provenance ?? 'asserted'),
      rows.map((r) => lower(r.learnedFrom ?? '')),
    ],
  );
}

/**
 * Delivery proved this format right. Promotes it out of 'asserted', which
 * is the whole point of the feedback loop.
 */
export async function confirmPattern({ domain, pattern, strong = true, tenantId = 1 }) {
  // Two strengths of good news, and they are not the same thing.
  //
  // A reply is proof: a human read it, so the address is right. Silence
  // after a send is only the absence of bad news - it also looks exactly
  // like this on a catch-all domain, which accepts everything and bounces
  // nothing. So delivery counts towards the evidence and is enough to let
  // a company out of probation, but only a reply promotes the format to
  // 'proven' and earns the higher confidence weighting.
  return execute(
    `UPDATE domain_patterns
        SET confirmed_count  = confirmed_count + 1,
            provenance       = CASE WHEN $4 THEN 'proven' ELSE provenance END,
            last_evidence_at = now()
      WHERE tenant_id = $1 AND lower(domain) = $2 AND pattern = $3`,
    [tenantId, normaliseDomain(domain), pattern, Boolean(strong)],
  );
}

/**
 * Predictions that were sent and have stayed quiet long enough to call
 * delivered.
 *
 * "Quiet" has to mean quiet *everywhere* we would hear about a failure, so
 * this excludes anything with a bounce event, a row in `bounces`, or a
 * suppression that says the address is bad - a bounce can arrive before the
 * prediction event is written, and the three are not the same table.
 *
 * It joins through `send_jobs` rather than trusting the prediction's own
 * age: a prediction that was never actually mailed has proved nothing, and
 * calling it delivered would manufacture evidence out of inactivity.
 */
export async function predictionsAwaitingConfirmation({
  afterHours = 48, limit = 500, tenantId = 1,
} = {}) {
  return query(
    `SELECT DISTINCT ON (p.id)
            p.id, p.domain, p.pattern, p.predicted_email,
            j.message_id, j.contact_id
       FROM email_predictions p
       JOIN contacts c
         ON c.tenant_id = p.tenant_id AND lower(c.email) = lower(p.predicted_email)
       JOIN send_jobs j
         ON j.contact_id = c.id AND j.status = 'sent' AND j.sent_at IS NOT NULL
       -- Only mailboxes that actually watch for bounces. Silence from a
       -- mailbox with IMAP off proves nothing: the bounce may well have
       -- arrived and simply never been read, and calling that address
       -- confirmed would teach the predictor a wrong format as right.
       JOIN mailboxes mb
         ON mb.id = j.mailbox_id AND mb.imap_enabled
      WHERE p.tenant_id = $1
        AND j.sent_at < now() - make_interval(hours => $2)
        AND NOT EXISTS (
          SELECT 1 FROM prediction_events e
           WHERE e.prediction_id = p.id AND e.event_type IN ('bounce', 'accepted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM bounces b WHERE lower(b.email) = lower(p.predicted_email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppressions s
           WHERE s.tenant_id = p.tenant_id
             AND lower(s.email) = lower(p.predicted_email)
             AND s.reason IN ('hard_bounce', 'soft_bounce_limit', 'invalid', 'complaint')
        )
      ORDER BY p.id, j.sent_at ASC
      LIMIT $3`,
    [tenantId, afterHours, limit],
  );
}

/** A hard bounce. Two of these with nothing to the format's credit retires it. */
export async function rejectPattern({ domain, pattern, tenantId = 1 }) {
  return execute(
    `UPDATE domain_patterns
        SET rejected_count   = rejected_count + 1,
            last_evidence_at = now()
      WHERE tenant_id = $1 AND lower(domain) = $2 AND pattern = $3`,
    [tenantId, normaliseDomain(domain), pattern],
  );
}

// ---------------------------------------------------------------- domains

export async function upsertDomainProfile({
  domain, hasMx = null, isFreeProvider = false, companyName = '', tenantId = 1,
}) {
  const host = normaliseDomain(domain);
  if (!host) return false;

  const changed = await execute(
    `INSERT INTO domain_profiles (tenant_id, domain, has_mx, is_free_provider, company_name, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, lower(domain)) DO UPDATE
        SET has_mx          = COALESCE(EXCLUDED.has_mx, domain_profiles.has_mx),
            is_free_provider = EXCLUDED.is_free_provider,
            company_name    = CASE WHEN domain_profiles.company_name = ''
                                   THEN EXCLUDED.company_name
                                   ELSE domain_profiles.company_name END,
            last_checked_at = now()`,
    [tenantId, host, hasMx, isFreeProvider, companyName],
  );
  return changed > 0;
}

// ------------------------------------------------------------------ seeds

/**
 * What our own data says about an address an operator claims is good.
 *
 * Cuts both ways. A hard bounce on record means they are wrong and the seed
 * must be refused before it teaches a wrong format to everyone at that
 * company. A delivery or a reply means we have proof, and the format learned
 * from it can skip straight past 'asserted'.
 *
 * Note the deliberate asymmetry on suppressions: `unsubscribed` and
 * `complaint` describe a person who does not want our mail, not a broken
 * mailbox. Those addresses are real, so they remain perfectly good teachers
 * even though we will never write to them again.
 */
export async function seedEvidence(email, tenantId = 1) {
  const address = lower(email);
  if (!address) return { provenance: 'asserted', blocked: null };

  const row = await queryOne(
    `SELECT
       EXISTS (SELECT 1 FROM bounces
                WHERE lower(email) = $2 AND bounce_type = 'hard')          AS hard_bounced,
       EXISTS (SELECT 1 FROM replies WHERE lower(email) = $2)              AS replied,
       EXISTS (SELECT 1 FROM send_jobs j
                 JOIN contacts c ON c.id = j.contact_id
                WHERE lower(c.email) = $2 AND j.status = 'sent')           AS delivered,
       (SELECT reason FROM suppressions
         WHERE tenant_id = $1 AND lower(email) = $2)                       AS suppression_reason`,
    [tenantId, address],
  );

  if (row?.hard_bounced) return { provenance: 'asserted', blocked: 'hard_bounced' };
  if (row?.suppression_reason === 'hard_bounce') return { provenance: 'asserted', blocked: 'hard_bounced' };
  if (row?.suppression_reason === 'invalid') return { provenance: 'asserted', blocked: 'suppressed_invalid' };

  // A reply is the strongest seed there is: the header carries the address
  // the person's own client sends as, which is their real mailbox rather
  // than an alias pointing at it.
  if (row?.replied || row?.delivered) return { provenance: 'proven', blocked: null };

  return { provenance: 'asserted', blocked: null };
}

// ------------------------------------------------------------ predictions

/** One insert for a whole run. */
export async function savePredictions(rows, { tenantId = 1, userId = null } = {}) {
  const usable = rows.filter((r) => r.predicted_email && r.domain);
  if (usable.length === 0) return 0;

  return execute(
    `INSERT INTO email_predictions
       (tenant_id, domain, input_name, first_name, middle_name, last_name,
        predicted_email, pattern, confidence, band, seed_email,
        name_confidence, name_source, reading_count, created_by)
     SELECT $1, d, i, f, m, l, e, p, c, b, s, nc, ns, rc, $15
       FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::numeric[], $10::text[], $11::text[],
                   $12::text[], $13::text[], $14::int[])
         AS t(d, i, f, m, l, e, p, c, b, s, nc, ns, rc)`,
    [
      tenantId,
      usable.map((r) => normaliseDomain(r.domain)),
      usable.map((r) => r.input_name ?? ''),
      usable.map((r) => r.first_name ?? ''),
      usable.map((r) => r.middle_name ?? ''),
      usable.map((r) => r.last_name ?? ''),
      usable.map((r) => lower(r.predicted_email)),
      usable.map((r) => r.pattern ?? ''),
      usable.map((r) => r.confidence ?? 0),
      usable.map((r) => r.band ?? 'low'),
      usable.map((r) => lower(r.seed_email ?? '')),
      // How the name was read. Cannot be reconstructed later, which is the
      // whole reason it is stored rather than derived on demand.
      usable.map((r) => r.name_confidence ?? ''),
      usable.map((r) => r.name_source ?? ''),
      usable.map((r) => r.reading_count ?? 1),
      userId,
    ],
  );
}

/**
 * Finds the prediction behind an address, so a bounce or a reply can be
 * attributed back to the format that produced it.
 *
 * Deliberately does not filter on `outcome IS NULL`, which it used to: an
 * address that was delivered to in March and hard bounces in June is
 * exactly the case worth learning from, and that filter threw it away.
 */
export async function predictionForEmail(email, tenantId = 1) {
  return queryOne(
    `SELECT * FROM email_predictions
      WHERE tenant_id = $1 AND lower(predicted_email) = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, lower(email)],
  );
}

/**
 * Appends an observation about a predicted address.
 *
 * Append-only on purpose. A delivery result cannot be reconstructed after
 * the fact, so everything is recorded even when nothing acts on it yet -
 * `learns_address` null included.
 *
 * Idempotent per (message_id, email, type, status): a re-read mailbox or a
 * provider repeating a DSN must not count twice.
 *
 * @returns {Promise<number>} rows inserted - 0 when it was a duplicate.
 */
export async function recordPredictionEvent({
  predictionId = null, contactId = null, email, eventType,
  reason = '', dsnStatus = '', learnsAddress = null, messageId = '',
  metadata = {}, tenantId = 1,
}) {
  const address = lower(email);
  if (!address || !eventType) return 0;

  return execute(
    `INSERT INTO prediction_events
       (tenant_id, prediction_id, contact_id, email, event_type,
        reason, dsn_status, learns_address, message_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      tenantId, predictionId, contactId, address, eventType,
      reason, dsnStatus, learnsAddress, messageId, JSON.stringify(metadata ?? {}),
    ],
  );
}

/**
 * Recomputes the denormalised `outcome` from the events.
 *
 * The events are the truth; this column is a cache so the UI and the stats
 * query do not have to aggregate. Precedence is worst-news-first: a wrong
 * address outranks a reply, because the reply cannot have come from a
 * mailbox that does not exist.
 */
export async function refreshPredictionOutcome(predictionId) {
  if (!predictionId) return 0;

  return execute(
    `UPDATE email_predictions p
        SET outcome = d.outcome,
            outcome_at = now()
       FROM (
         SELECT prediction_id,
                CASE
                  WHEN bool_or(event_type = 'bounce' AND learns_address IS TRUE)
                    THEN 'hard_bounce'
                  WHEN bool_or(event_type = 'reply')    THEN 'replied'
                  WHEN bool_or(event_type = 'accepted') THEN 'delivered'
                  WHEN bool_or(event_type = 'bounce')   THEN 'soft_bounce'
                  ELSE NULL
                END AS outcome
           FROM prediction_events
          WHERE prediction_id = $1
          GROUP BY prediction_id
       ) d
      WHERE p.id = d.prediction_id
        AND d.outcome IS NOT NULL`,
    [predictionId],
  );
}

/** Every observation about one address, oldest first. */
export async function eventsForEmail(email, tenantId = 1) {
  return query(
    `SELECT * FROM prediction_events
      WHERE tenant_id = $1 AND lower(email) = $2
      ORDER BY occurred_at ASC`,
    [tenantId, lower(email)],
  );
}

/** Headline counts for the predictor page. */
export async function predictorStats(tenantId = 1) {
  const row = await queryOne(
    `SELECT
       (SELECT count(*)::int FROM domain_patterns WHERE tenant_id = $1)                        AS formats_known,
       (SELECT count(DISTINCT lower(domain))::int FROM domain_patterns WHERE tenant_id = $1)   AS companies_known,
       (SELECT count(*)::int FROM domain_patterns
         WHERE tenant_id = $1 AND provenance = 'proven')                                       AS formats_proven,
       (SELECT count(*)::int FROM email_predictions WHERE tenant_id = $1)                      AS predictions_made,
       (SELECT count(*)::int FROM email_predictions
         WHERE tenant_id = $1 AND outcome IN ('delivered', 'replied'))                         AS predictions_landed,
       (SELECT count(*)::int FROM email_predictions
         WHERE tenant_id = $1 AND outcome = 'hard_bounce')                                     AS predictions_bounced`,
    [tenantId],
  );
  return row ?? {};
}
