# Mail Predictor

Work out a prospect's email address from one address you already know at their
company.

The premise the whole feature rests on: **a company uses one address format for
everyone.** IT configured a rule once — `first.last@`, `flast@`, `first@` — and
every employee was provisioned from it. So one confirmed address at a domain
tells you everyone else's address at that domain.

That turns prediction into a lookup, and the lookup gets cheaper over time:
every company whose format we learn is a company nobody ever has to supply a
seed for again.

---

## What it is not

It is not a verifier. We never ask a mail server whether a mailbox exists —
that needs outbound port 25, which Render blocks, and it answers "yes" for every
address on the many corporate domains that accept catch-all mail. Verification
here is the thing we already do: send, and read the bounce.

It is not an LLM guessing addresses. The model is confined to splitting a human
name into parts. It never sees a domain and never emits an address. Everything
between a name and an address is deterministic string work, because a model
asked "what format does Acme use" will answer `first.last` with total
confidence whether or not it knows.

---

## The algorithm

### Inputs

| | | |
|---|---|---|
| Seed address | `priya.nair@apex.com` | required, unless we already know the domain |
| Seed owner | `Priya Nair` | auto-filled when the seed is already in `contacts` |
| Targets | `Rajesh Kumar Sharma`, ... | one or many |

The domain falls out of the seed, so there is no company-name-to-website step
and no DNS guessing for it.

### Step 1 — Qualify the seed

A bad seed teaches a wrong format to every prospect at that company, so this
gate runs before anything is learned.

**Reject** when:

- the address is malformed, or its domain has no MX
- the local part is a role account (`info@`, `sales@`, `careers@`) — a shared
  mailbox follows no personal format, so there is nothing to learn from it.
  `ROLE_PREFIXES` in `server/src/lib/email-validation.js` already lists these
- the domain is disposable — same list, same file
- **the domain is a consumer mailbox provider** — `gmail.com`, `outlook.com`,
  `yahoo.com`, `rediffmail.com` and the rest. A personal address has no company
  format; the local part is whatever the person picked at signup. This is a
  correctness requirement, not hygiene: without it the learner groups every
  Gmail prospect into one "company", concludes `gmail.com` uses `first.last`,
  and confidently predicts `john.smith@gmail.com` for all of them. Found by
  running the backtest against real data — see
  `server/scripts/backtest-patterns.js`, which carries the provider list
- **our own `bounces` table has a hard bounce for it.** The operator believes it
  works; a receiving mail server is on record saying otherwise. Show them the
  bounce date rather than a bare rejection
- `suppressions` holds it with reason `hard_bounce` or `invalid`

**Accept** when `suppressions` holds it with reason `unsubscribed` or
`complaint`. Those addresses are real and deliverable — the person simply does
not want our mail. That is a rule about who we may contact, not about what the
company's format is. Rejecting these would throw away good seeds for no reason.

**Promote** when our own data proves it:

| Evidence | Provenance | Weight |
|---|---|---|
| A reply arrived from it (`replies`) | `proven` | 1.00 |
| We sent to it and it did not bounce (`send_jobs`) | `proven` | 1.00 |
| Operator asserts it, nothing contradicts | `asserted` | 0.85 |

A reply is the strongest seed available: the header carries the address the
person's own mail client sends as, which is their canonical mailbox rather than
an alias pointing at it.

### Step 2 — Learn the format, backwards

Normalise the seed owner's name, then run every template and keep the ones that
reproduce the seed exactly.

Normalisation matters more than it looks. Without it, real addresses fail to
match for silly reasons:

```
NFD decompose, strip combining marks   García  -> Garcia
lowercase                              Nair    -> nair
strip ' - . and internal spaces        O'Brien -> obrien
                                       van der Berg -> vanderberg
```

For `van der Berg` also try the bare final token (`berg`), since companies
disagree about particles.

The template set, with `Priya Nair` at `apex.com`:

| Pattern | Produces |
|---|---|
| `first.last` | `priya.nair@` |
| `first_last` | `priya_nair@` |
| `firstlast` | `priyanair@` |
| `first-last` | `priya-nair@` |
| `first` | `priya@` |
| `last` | `nair@` |
| `flast` | `pnair@` |
| `f.last` | `p.nair@` |
| `f_last` | `p_nair@` |
| `firstl` | `priyan@` |
| `first.l` | `priya.n@` |
| `lastf` | `nairp@` |
| `last.first` | `nair.priya@` |
| `lastfirst` | `nairpriya@` |
| `last_first` | `nair_priya@` |
| `fl` | `pn@` |
| `f.l` | `p.n@` |
| `firstmlast` | `priyaknair@` |
| `first.m.last` | `priya.k.nair@` |

Three outcomes, all of which need handling:

- **One match** — the normal case. Format identified.
- **Several match** — happens with short names or shared initials. Keep them
  all; later evidence narrows it. Do not pick one arbitrarily.
- **No match** — the company uses something outside the set: employee numbers,
  a nickname, a truncation rule. Say so plainly and ask for a different seed.
  Do not force an answer.

### Step 3 — Split the target name

Rules first, because they handle the overwhelming majority at zero cost and
zero latency:

1. cut everything after `|`, `@`, `,`, or ` - ` — LinkedIn headlines arrive as
   `Rajesh Sharma | CTO @ Apex`
2. strip emoji, pronouns (`(he/him)`), and credentials (`PhD`, `MBA`, `CPA`)
3. strip titles (`Dr.`, `Prof.`, `Mr.`)
4. lift quoted or parenthesised nicknames out — `Mike (Michael) Chen` yields
   both `Mike` and `Michael` as first-name candidates
5. split on whitespace: two tokens is first/last; three or more is
   first / middle(s) / last; one token is ambiguous

Anything the rules cannot resolve — single tokens, non-Latin scripts,
surname-first ordering — goes to the model, which returns
`{first, middle, last, confidence}` and nothing else.

### Step 4 — Apply, check, band

Apply the learned format to the target's parts. Then:

- valid syntax, local part under 64 characters
- not in `suppressions`
- not already in `contacts` under another spelling
- did not accidentally come out as a role address

Confidence is multiplicative and then banded:

```
score = seedProvenance          (1.00 proven | 0.85 asserted)
      x patternMatches          (1.00 one | 0.60 two | 0.40 three+)
      x nameParse               (1.00 rules | 0.90 model | 0.60 ambiguous)

>= 0.85  High     send normally
0.60-0.85 Medium  show alternatives, send in a small slice first
<  0.60  Low      do not send unattended
```

Bands are shown as words, never percentages. `0.73` implies a precision this
does not have.

### Step 5 — Remember the company

Write `apex.com -> first.last` to pattern memory with its evidence count.

This is the step that makes the feature worth building rather than buying. The
next 49 people at Apex need no seed, cost nothing, and return instantly — and
so does every Apex prospect six months from now.

**Conflicts are not overwritten.** If memory says `first.last` and a new seed
implies `flast`, that disagreement is real information: the company changed
schemes, or one address is an alias, or one is simply wrong. Keep both, let the
stronger provenance win, and flag it. Two live formats at one company is rare
but does happen after an acquisition.

### Step 6 — Learn from the outcome

The inbox poller already classifies bounces and detects replies. Wire it back:

- **hard bounce** — either that person has left, or the format is wrong. Two
  hard bounces at one domain on the same format means the format is wrong:
  demote it and fall back to the next candidate.
- **delivered, or replied** — promote the format from `asserted` to `proven`.

Seed-derived formats sit one notch below delivery-proven ones until a real send
confirms them, so a single mistyped seed cannot quietly poison fifty addresses.

---

## Speed at bulk

The governing property: **work scales with companies, not rows.** A 5,000-row
file across 400 companies is 400 units of real work and 5,000 units of string
formatting.

The run is phased so that all I/O of a kind happens at once:

| Phase | I/O |
|---|---|
| Parse CSV, collect distinct domains | none |
| Load every known pattern — `WHERE domain = ANY($1::text[])` | **1 query** |
| Group rows by domain | none |
| Reverse-match seeds for unknown domains | none — pure CPU |
| MX check for domains still unknown | 1 batched pass, 25 concurrent |
| Name parsing, rules path | none |
| Name parsing, model path — **50 names per call**, not one | ~N/50 calls |
| Generate addresses from templates | none |
| Suppression and duplicate check — one `ANY($1)` | **1 query** |
| Persist predictions | **1 bulk insert** |

Single-digit round trips regardless of file size. The cost is entirely in model
calls for unparseable names and DNS for first-seen domains — both of which fall
to near zero on the second run against the same companies.

Rules to hold to:

- **never query per row.** Every lookup is batched by domain or by `ANY($1)`.
- **cache patterns in a `Map` for the duration of a run**, so a 400-row domain
  group hits the database once.
- reuse `createMxChecker` from `email-validation.js` — it already caches per
  domain and bounds concurrency at 25.
- batch model calls at 50 names; one call per name is the single biggest
  latency mistake available here.

Synchronous request/response, matching the existing CSV import, with the same
10 MB ceiling. If files ever outgrow that, the `send_jobs` worker pattern is
the upgrade path — but that is not a v1 problem.

---

## Schema

Three tables, tenant-scoped like everything else in `001_init.sql`.

```sql
CREATE TABLE domain_profiles (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER     NOT NULL DEFAULT 1,
  domain          TEXT        NOT NULL,
  has_mx          BOOLEAN,
  mx_provider     TEXT        NOT NULL DEFAULT '',
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_domain_profiles ON domain_profiles (tenant_id, lower(domain));

-- One row per (domain, format) with its running evidence. Several rows per
-- domain is legitimate - it is how a contested format is represented until
-- delivery settles it.
CREATE TABLE domain_patterns (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER     NOT NULL DEFAULT 1,
  domain          TEXT        NOT NULL,
  pattern         TEXT        NOT NULL,
  provenance      TEXT        NOT NULL DEFAULT 'asserted'
                              CHECK (provenance IN ('asserted', 'proven')),
  confirmed_count INTEGER     NOT NULL DEFAULT 0,
  rejected_count  INTEGER     NOT NULL DEFAULT 0,
  learned_from    TEXT        NOT NULL DEFAULT '',
  last_evidence_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_domain_patterns ON domain_patterns (tenant_id, lower(domain), pattern);

-- Audit trail. `outcome` is written by the inbox poller, and is what closes
-- the learning loop.
CREATE TABLE email_predictions (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER     NOT NULL DEFAULT 1,
  domain          TEXT        NOT NULL,
  input_name      TEXT        NOT NULL,
  first_name      TEXT        NOT NULL DEFAULT '',
  last_name       TEXT        NOT NULL DEFAULT '',
  predicted_email TEXT        NOT NULL,
  pattern         TEXT        NOT NULL,
  confidence      NUMERIC(3,2) NOT NULL,
  band            TEXT        NOT NULL CHECK (band IN ('high', 'medium', 'low')),
  seed_email      TEXT        NOT NULL DEFAULT '',
  contact_id      INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  outcome         TEXT        CHECK (outcome IS NULL OR outcome IN
                              ('delivered', 'replied', 'hard_bounce', 'soft_bounce')),
  created_by      INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_predictions_domain ON email_predictions (tenant_id, lower(domain));
CREATE INDEX idx_predictions_outcome ON email_predictions (outcome) WHERE outcome IS NULL;
```

### The free head start

Before any of this ships, one script backfills `domain_patterns` from the
`contacts` table. Every existing contact already carries `email`, `first_name`,
`last_name` — which is exactly a seed and its owner. Reverse-match each one and
the pattern memory wakes up populated with real companies.

The feature is never cold on day one, and the script is the reverse matcher
called in a loop.

---

## UI

A new sidebar entry, **Mail Predictor**, between Contacts and Campaigns — it
feeds the former and precedes the latter. Route `/predictor`.

One page, two modes.

### Mode: One company

```
+-- Company -----------------------------------------------+
|  A working address at this company                        |
|  [ priya.nair@apex.com                            ]       |
|  OK  Format learned: first.last                           |
|      from a reply on 12 Oct - highest confidence           |
|                                                            |
|  Whose address is it?                                      |
|  [ Priya Nair                                     ]       |
|      filled in from your contacts                          |
+------------------------------------------------------------+

+-- People ---------------------------------------------------+
|  One name per line                                           |
|  +--------------------------------------------------------+ |
|  | Rajesh Kumar Sharma                                     | |
|  | Mike (Michael) Chen                                     | |
|  | Dr. Maria Jose Garcia-Lopez                             | |
|  +--------------------------------------------------------+ |
|                                      [ Predict 3 addresses ] |
+--------------------------------------------------------------+

Results
  Rajesh Kumar Sharma    rajesh.sharma@apex.com     High
  Michael Chen           michael.chen@apex.com      Medium  v alternatives
                                                      mike.chen@apex.com
  Maria Garcia-Lopez     maria.garcia@apex.com      Medium  v alternatives

                                           [ Add 3 to list v ]
```

**Many names per seed, not one.** One seed unlocks the whole company, so asking
for people one at a time would waste the entire premise.

When the domain is already known the seed block collapses to a single line —
*"We already know apex.com: `first.last`, confirmed by 4 delivered sends"* —
and the operator types names and nothing else. That collapse is the feature
paying off, so it should be the most visible state on the page.

### Mode: CSV upload

Mirrors the two-step preview/commit import already in `Contacts.jsx`, because
operators know that flow:

1. drop the file, map columns (name, company or domain, seed address)
2. preview reports the counts — *312 high, 84 medium, 41 no format found* —
   grouped by company, with the companies that need a seed listed first
3. commit writes them into a named list

### Decisions worth stating

- **Words, not percentages.** `High` / `Medium` / `Low`. A number implies
  precision the model does not have.
- **Nothing auto-enters a campaign.** Predictions land in a contact list the
  operator reviews. The failure mode here is a bounce storm against the sending
  domain, and a human glance is cheap insurance.
- **Alternatives are shown inline** for Medium, not hidden behind a detail page.
  If there are two plausible answers the operator should see both while
  deciding.
- **Failures are explicit.** "No format matched this seed" is a real result
  with a real next action, not a blank row.

---

## Build order

1. **Reverse matcher and template set** — `server/src/lib/email-patterns.js`,
   pure functions, unit-tested with no database. About 30 lines for the matcher.
2. **Name parser** — `server/src/lib/parse-name.js`, rules only, model path
   stubbed. Tested against the awkward cases above.
3. **Migration `003`** plus the contacts backfill script. Run it and see what
   the existing data already knows — that number decides how much the rest
   matters.
4. **`server/src/db/repositories/predictions.js`** — batched reads, bulk insert.
5. **`server/src/routes/predictor.js`** — `POST /api/predictor/seed` (qualify a
   seed, return the learned format), `POST /api/predictor/predict` (names in,
   addresses out), `POST /api/predictor/bulk` (CSV, preview/commit). Mounted in
   `index.js` alongside the rest, behind `requireAuth`.
6. **Model fallback** for names the rules cannot split. Batched 50 per call,
   API key from the environment, feature-flagged off so everything above works
   without it.
7. **`web/src/pages/Predictor.jsx`** plus the nav entry.
8. **Outcome writeback** in `workers/inbox-poller.js`.

Steps 1–3 are the whole engine and need no frontend, no model, and no new
dependency. They can be tested entirely from `node --test`.

---

## Open questions

- **Rate limiting.** The predict endpoint enumerates staff at a company, which
  is worth a tighter limit than the general `apiLimiter`.
- **Cross-tenant pattern sharing.** A format like `apex.com -> first.last` is
  arguably not tenant data, and sharing it would make every tenant's predictions
  better immediately. But the evidence behind it is tenant data, and the schema
  isolates by default. Left isolated in v1; worth revisiting deliberately rather
  than by accident.
- **Name collisions.** Two R. Sharmas means one is `rsharma2@` and no pattern
  logic will say which. Currently unsolved, and probably unsolvable without
  verification.
- **Names written in a non-Latin script.** They parse correctly now, but an
  address needs Latin characters, so predicting one would mean
  transliterating - producing a word the operator never supplied. The model
  guard in `name-intelligence.js` refuses exactly that, on purpose: it is the
  rule that stops a hallucinated surname reaching a mailbox. Relaxing it for
  transliteration only is possible but is a real trade, so those rows are
  reported as unbuildable instead.
- **Retiring a format does not yet propose the next one.** Two hard bounces
  drop a format, and the company then reads as unknown rather than falling
  back to the next-ranked candidate. Two departures therefore look exactly
  like a wrong format, and a fresh correct seed cannot currently clear an old
  rejection count.
