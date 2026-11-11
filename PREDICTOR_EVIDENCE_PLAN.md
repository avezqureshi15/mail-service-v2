# Predictor Evidence & Relearning Plan

Make future address predictions for a company use that company's own
history — what formats were predicted, how often the mail was accepted,
replied to, or bounced — so the next prediction is deliberate rather than
a fresh guess.

The guiding rule (and the existing code's intent): **the format is decided by
evidence, not by a language model.** The LLM is used where it is genuinely
better than rules — reading an awkward human name. The scorer owns the
format; the LLM does not.

---

## 1. Current state and gaps

| Area | Today | Problem |
| --- | --- | --- |
| Bounce classification | `classifyBounce` treats every `5.x.x` as `hard` (`inbox-poller.js`) | A `5.7.1` spam block, `5.4.x` routing failure or `5.7.26` auth failure demotes a perfectly good format |
| Outcome storage | One `email_predictions.outcome` column, written once | A later bounce after an earlier outcome is never attributed; `predictionForEmail` filters `outcome IS NULL` |
| Positive evidence | Only a reply confirms a format | Accepted deliveries are ignored; learning is slow |
| Retirement | `rejected_count >= 2 && confirmed_count === 0` | Blunt: one bad bounce can retire a good format; a wrong format can linger |
| Attribution | Bounce is charged to the format | A bounce may be the name split, not the format |
| Re-selection | Alternatives are computed but never used after a bounce | No "try the next candidate" path |
| Catch-all | Not modelled | Accept-all domains produce no bounces, so silence looks like success |
| Rollout | Every company gets the whole list at once | A brand-new company can be mailed with many guesses |

---

## 2. Target architecture

```
domain + name
  -> name engine: rules readings + optional LLM readings (ambiguity only)
  -> domain intelligence: patterns + event-derived history + rollout state
  -> candidate generation: readings x formats
  -> deterministic scorer (authoritative):
        format posterior (Beta, reason-filtered)
      x reading confidence
      x base-rate prior
      x catch-all discount
      x sample-size caution
  -> optional LLM tie-break (reading only, constrained, never an address)
  -> prediction + alternatives + explanation + evidence snapshot
  -> feedback: events -> classified -> updated history
```

Key invariants:

- The scorer is authoritative for the format.
- The LLM never sees a domain-to-format question and never emits an address.
- Every prediction stores enough to be explained later (`scoring_version`,
  candidate scores, evidence snapshot).

---

## 3. Data model (migration `004_prediction_evidence.sql`)

### 3.1 `prediction_events` — source of truth

Append-only observations about a predicted address. Never overwrite; derive
the current status from the events.

```sql
CREATE TABLE prediction_events (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  prediction_id  INTEGER REFERENCES email_predictions (id) ON DELETE CASCADE,
  contact_id     INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  email          TEXT NOT NULL,
  event_type     TEXT NOT NULL CHECK (event_type IN (
                   'sent', 'accepted', 'bounce', 'reply', 'complaint',
                   'no_bounce_window', 'manual')),
  -- Bounce detail, NULL for non-bounce events.
  reason         TEXT,
  dsn_status     TEXT NOT NULL DEFAULT '',
  -- true = address is wrong; false = not address-related; null = unclear.
  learns_address BOOLEAN,
  weight         NUMERIC(4,2) NOT NULL DEFAULT 1,
  message_id     TEXT NOT NULL DEFAULT '',
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_pred_events_prediction ON prediction_events (prediction_id);
CREATE INDEX idx_pred_events_email      ON prediction_events (lower(email));
CREATE INDEX idx_pred_events_domain     ON prediction_events (tenant_id, occurred_at);
CREATE UNIQUE INDEX idx_pred_events_unique
  ON prediction_events (message_id, lower(email), event_type, dsn_status)
  WHERE message_id <> '';
```

### 3.2 `prediction_attempts` — per-person retry memory

```sql
CREATE TABLE prediction_attempts (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  domain         TEXT NOT NULL,
  input_name     TEXT NOT NULL,
  contact_id     INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  prediction_id  INTEGER REFERENCES email_predictions (id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  email          TEXT NOT NULL,
  pattern        TEXT NOT NULL DEFAULT '',
  reading        JSONB NOT NULL DEFAULT '{}',
  outcome        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attempts_person ON prediction_attempts (tenant_id, lower(domain), lower(input_name));
```

### 3.3 Extends

```sql
ALTER TABLE bounces
  ADD COLUMN dsn_status     TEXT NOT NULL DEFAULT '',
  ADD COLUMN reason         TEXT NOT NULL DEFAULT '',
  ADD COLUMN learns_address BOOLEAN;

ALTER TABLE domain_profiles
  ADD COLUMN catch_all TEXT NOT NULL DEFAULT 'unknown'
    CHECK (catch_all IN ('confirmed', 'suspected', 'not_catch_all', 'unknown'));

ALTER TABLE email_predictions
  ADD COLUMN scoring_version  TEXT    NOT NULL DEFAULT '',
  ADD COLUMN judged_by        TEXT    NOT NULL DEFAULT 'rules',
  ADD COLUMN evidence         JSONB   NOT NULL DEFAULT '{}',
  ADD COLUMN candidate_scores JSONB   NOT NULL DEFAULT '[]';
```

Keep `email_predictions.outcome` as a denormalized "latest status" cache for
fast reads; `prediction_events` is the truth.

---

## 4. P0 — Bounce classification

### 4.1 Reason and tri-state `learns_address`

Extend `classifyBounce` (or add `classifyBounceReason`) to return:

```js
{ type: 'hard' | 'soft' | 'unknown', reason, learnsAddress: true | false | null }
```

| DSN / condition | reason | learnsAddress |
| --- | --- | --- |
| `5.1.1` user unknown, `no such user`, `invalid recipient` | `user_unknown` | `true` |
| `5.1.3` bad destination syntax | `bad_syntax` | `true` |
| `5.1.6` / `5.2.1` mailbox disabled / moved | `mailbox_unavailable` | `null` |
| `5.2.2` / quota full | `mailbox_full` | `false` (soft) |
| `5.4.x` routing | `domain_unreachable` | `false` |
| `5.7.1` policy / spam block | `policy_block` | `false` |
| `5.7.26` / auth | `auth_failure` | `false` |
| `4.x.x` transient / greylist | `transient` | `null` |
| out-of-office / auto-reply | `auto_reply` | `false` (not a bounce at all) |

Rule: **only `learnsAddress === true` may demote a format.** `null` is a weak
signal, `false` is neutral.

### 4.2 Handling

- `handleBounce` still records the row in `bounces` (campaign/reputation) and
  also writes a `prediction_events` row with the full detail.
- Auto-replies / OOO are no longer counted as soft bounces; they record an
  event (a valid mailbox) and pause sequences at most.
- `notePredictionOutcome` is replaced by an event append. Stop relying on the
  `outcome IS NULL` filter. A later hard bounce is always recorded.
- `setPredictionOutcome` becomes a cache update derived from events, with
  precedence `hard_bounce > replied > accepted > sent`.

---

## 5. P1 — History and scoring

### 5.1 Aggregation

New repository function:

```js
// predictions.js
export async function formatHistoryForDomains(domains, tenantId = 1, { sinceDays = 180 } = {})
// -> Map<domain, Array<{
//      pattern, predicted, sent, accepted, replied,
//      hardAddressBounce, hardNeutralBounce, policyBlock, soft, lastEvidenceAt
//    }>>
```

Derived from `email_predictions` joined to `prediction_events` (not from the
`outcome` cache), grouped by `(domain, pattern)`. Include rows with `n = 0` so
untried formats are visible to the scorer.

### 5.2 Beta scoring — `beta-v1`

Per `(domain, pattern)`:

```
alpha = 1 + 3*replied + 1*accepted + 0.5*noBounceWindow
beta  = 1 + 3*hardAddressBounce + 0.5*hardNeutralBounce
formatScore = alpha / (alpha + beta)
```

- Replies are the strongest positive; accepted/no-bounce is weak.
- Policy/routing/auth bounces are excluded (`learnsAddress = false`).
- Sample-size caution: only let the evidence reorder the answer when
  `n >= MIN_EVIDENCE` (default 3, configurable). Below that, the base-rate
  prior (`PATTERNS` order) dominates.
- Catch-all: if `catch_all` is `confirmed`/`suspected`, decay all
  bounce/delivery evidence and rely on replies.

Candidate score:

```
candidateScore = formatScore
               * readingConfidence      // model 'clean' > rules, ambiguous lower
               * patternPrior           // PATTERNS rank as a weak prior
               * catchAllDecay
```

Store `scoring_version = 'beta-v1'` and the full `candidateScores` JSON on the
prediction.

### 5.3 Attribution: format vs name reading

A `5.1.1` on `qureshi@` could be the format (`last`) or the split
(`Qureshi` chosen as family). Therefore:

- Name reading was **high-confidence** -> the bounce updates the **format**
  posterior.
- Name reading was **ambiguous** -> update the **reading** prior (and weight
  the format evidence low).
- Repeated `hardAddressBounce` across **different people** at the same domain
  -> strong format evidence, demote the format.
- A single bounce while others at the domain are accepted/replied -> flag the
  person, keep the format.

This is computed in the scorer and stored in `evidence` so it stays explainable.

---

## 6. P1 — Rollout / probation (probe first)

Two levels:

- **Company (domain):** format trust + probe budget.
- **Person (domain + normalized name):** candidate addresses and attempts.

### 6.1 Company state

| State | Meaning | `/predict` reveals |
| --- | --- | --- |
| `unknown` | no seed, no history | nothing; ask for a seed |
| `probing` | format asserted, no feedback yet | up to `probeBudget` people (default 1), primary only; alternatives hidden |
| `validated` | format confirmed | all people, all ranked candidates |
| `disputed` | address bounces dominate | failed addresses excluded; next probe(s) only |
| `catch_all_suspected` | accepts everything, no replies | low confidence; replies only |

### 6.2 Feedback-gated transitions

- **Reply** -> `validated` immediately.
- **Accepted + no hard bounce within 48h** -> `validated` (practical delivery
  signal; catch-all discount applies).
- **Hard bounce, `learnsAddress = true`** -> demote candidate; stay `probing`
  (next probe) or `disputed`.
- **Hard bounce, `learnsAddress = false`** -> no format change; stay `probing`;
  retry later.
- **Soft / OOO** -> stay `probing`; pause sequences; no format penalty.
- **Manual "unlock all"** -> `validated`, `judged_by = 'manual'`, audited.

A second request with no new feedback stays `probing` — a click is not
evidence.

### 6.3 Per-person attempts

- Record every candidate that is actually sent, with `attempt_number`,
  `pattern`, `reading`, and outcome.
- Never re-recommend a failed address for that person.
- On an address bounce, the next alternative for that person is the next probe.

### 6.4 Response

`/predict` gains:

```json
"rollout": {
  "state": "probing",
  "probe": true,
  "probeBudget": 1,
  "used": 1,
  "hiddenPeople": 3,
  "hiddenAlternatives": 3,
  "nextAction": "Send this one and record the outcome; then the rest unlock."
}
```

All candidates are still computed and stored for audit; only the response is
gated. Bulk upload reveals up to the probe budget per `probing` domain and
holds the rest.

---

## 7. LLM contract

### Call 1 — name parts (required, batched)

Already implemented in `name-intelligence.js`. The model returns
`given / middle / family / short` only.

- Used to build readings; the scorer applies the format.
- Model output is validated against the operator's supplied words; invalid
  answers fall back to the rules.
- The LLM never sees the seed address and never emits an address.

### Call 2 — ambiguity tie-break (optional, deferred to P2)

Only when the scorer's top candidates differ mainly by name reading (leading
initial, compound surname, nickname).

- Input: domain + country hint, the name, the candidate readings, and the
  aggregated format history as context.
- Output: a reading index (`choice`), `confidence`, `reason`, or `-1` for
  insufficient evidence.
- The LLM picks a **reading**, not a format or address. The scorer still
  chooses the format.
- Constrained + validated; invalid -> deterministic result.
- Off by default. Decision pending.

### Never asked

- "What format does this company use?"
- "What is this person's email?"
- Other people's raw addresses (only aggregated counts).

---

## 8. Priority

| Priority | Task | Status |
| --- | --- | --- |
| P0 | Bounce classification with tri-state `learns_address` | **done** — `src/lib/bounce-reason.js` |
| P0 | Append-only `prediction_events`; derive status; drop write-once outcome | **done** — migration `004` |
| P1 | Rollout/probation + feedback gating | **done** — `src/lib/rollout.js` |
| P1 | Delivery confirmation sweep (§6.2 "accepted + no bounce in 48h") | **done** — `src/workers/delivery-confirmer.js` |
| P1 | `formatHistoryForDomains` aggregation | pending |
| P1 | Deterministic `beta-v1` scorer with format-vs-reading attribution | deferred — see below |
| P1 | Per-person `prediction_attempts` | deferred — overlaps `prediction_events` |

Rollout was pulled ahead of the scorer deliberately: it needs no accumulated
evidence to be worth having, where the scorer is arithmetically inert until a
`(domain, pattern)` cell has several observations. With 4 predictions and 0
recorded outcomes at the time of writing, the scorer would have computed the
base-rate prior with extra steps for months, while freezing invented weights
into a `scoring_version` to migrate off later.

Two deviations from §6 as written. The rollout state is **derived** from
`domain_patterns` rather than stored — a stored state is a second copy of the
truth that every code path has to transition correctly, and the first missed
transition leaves a company wrongly locked or wrongly open. And `catch_all_suspected`
is not implemented, because catch-all detection is P2: it would have been a
state nothing could enter.

| P2 | Optional LLM ambiguity tie-break (Call 2) |
| P2 | Catch-all detection (`confirmed` only via explicit probe) |
| P2 | Evidence explanation in the Predictor UI |
| P3 | Calibration / accuracy analytics |

---

## 9. Tests

**Bounce classification**
- `5.1.1` -> `learns_address = true`, demotes.
- `5.7.1`, `5.4.x`, `5.7.26` -> `false`, no format change.
- `5.2.1` / unknown -> `null`, weak.
- OOO is not a bounce and does not suppress.

**Events**
- Accepted then later bounced -> both events stored; derived status is the
  bounce.
- Duplicate DSN (same message/email/type) is idempotent.

**Scoring**
- 2 successes do not outweigh 200 (`beta-v1` smoothing).
- One bounce with an ambiguous reading does not demote the format.
- Three `user_unknown` bounces across different people demote it.
- Policy bounces never demote.
- Untried format is not eliminated for lack of data.
- Catch-all domain ignores bounce/delivery evidence.

**Rollout**
- `unknown` -> nothing predictable.
- `probing` -> exactly `probeBudget` rows, alternatives hidden.
- Reply -> `validated`, all rows returned.
- Address bounce -> failed address excluded, next probe offered.
- Policy bounce -> still `probing`, format unchanged.
- Second request with no feedback -> still `probing`.
- Manual unlock works and is audited.

**Audit**
- Every prediction stores `scoring_version`, candidate scores, and evidence
  snapshot; an old prediction can be explained after the algorithm changes.

---

## 10. Deferred / decisions

- **Call 2 (LLM ambiguity):** ship with Call 1 + deterministic scorer first;
  enable Call 2 only if real data shows ambiguous names are a material error
  source.
- **Catch-all probing:** a live RCPT probe is intrusive and rate-limit prone.
  Default to behavioral `suspected`; only `confirmed` via explicit probe.
- **Probe budget:** default 1 per company; operator may raise it per run.
- **Auto-retry:** not in this plan. On an address bounce we *suggest* the next
  candidate; sending to additional guesses automatically is a separate,
  reputation-sensitive decision.

---

## 11. Files touched

- `server/src/db/migrations/004_prediction_evidence.sql` — new events/attempts
  tables and columns.
- `server/src/workers/inbox-poller.js` — reason classification, event append,
  remove write-once outcome, OOO fix.
- `server/src/db/repositories/predictions.js` — `formatHistoryForDomains`,
  event-derived stats, attempt recording, retention/aggregation helpers.
- `server/src/lib/email-patterns.js` — keep builders/matchers; move confidence
  to the scorer (retain `scoreConfidence` for compatibility or retire it).
- `server/src/lib/predictor.js` — candidate scoring, attribution, evidence
  snapshot, `scoring_version`.
- `server/src/routes/predictor.js` — load history before prediction, rollout
  gating, persist attempts and evidence, response shape.
- `server/src/lib/name-intelligence.js` — unchanged for Call 1; optional
  `format-judge.js` for Call 2 later.
- `server/src/db/repositories/settings.js` — `MIN_EVIDENCE`, probe budget,
  no-bounce window.
- `server/test/` — new tests listed in section 9; update existing confidence
  assertions if `scoreConfidence` is retired.
- `web/src/pages/Predictor.jsx` — probe banner, hidden alternatives count,
  manual unlock, evidence explanation (P2).
