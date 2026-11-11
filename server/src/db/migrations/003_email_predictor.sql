-- Mail Predictor: working out a prospect's address from one known address
-- at the same company.
--
-- The value is not in the guessing, which is twenty lines of string
-- formatting. It is in `domain_patterns`: once a company's format is known
-- it never has to be supplied again, and on a real prospect list one
-- learned format averages about ten free addresses.

-- What we know about a domain itself, separate from its format. Mostly a
-- cache, so a bulk run resolves MX once per domain rather than once per row.
CREATE TABLE domain_profiles (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  domain            TEXT        NOT NULL,
  -- NULL means never checked, as distinct from checked and absent.
  has_mx            BOOLEAN,
  -- Consumer mailbox providers have no company format at all. Recorded so
  -- the seed check can reject them without re-deriving it every time.
  is_free_provider  BOOLEAN     NOT NULL DEFAULT FALSE,
  company_name      TEXT        NOT NULL DEFAULT '',
  last_checked_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_domain_profiles ON domain_profiles (tenant_id, lower(domain));

-- One row per (domain, format), with its running evidence.
--
-- Several rows for one domain is legitimate rather than a conflict to
-- resolve eagerly: a short name can be explained by more than one format,
-- and a company that has been acquired really does run two. Delivery
-- settles it over time.
CREATE TABLE domain_patterns (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  domain            TEXT        NOT NULL,
  -- A key from PATTERNS in src/lib/email-patterns.js, e.g. 'first.last'.
  pattern           TEXT        NOT NULL,
  -- 'asserted' - an operator supplied a seed and we believed them.
  -- 'proven'   - our own delivery or a reply confirmed it.
  -- A seed stays one notch below delivery so a single mistyped address
  -- cannot quietly poison every prediction at that company.
  provenance        TEXT        NOT NULL DEFAULT 'asserted'
                                CHECK (provenance IN ('asserted', 'proven')),
  confirmed_count   INTEGER     NOT NULL DEFAULT 0,
  rejected_count    INTEGER     NOT NULL DEFAULT 0,
  -- The address this format was learned from, for explaining the answer.
  learned_from      TEXT        NOT NULL DEFAULT '',
  last_evidence_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_domain_patterns ON domain_patterns (tenant_id, lower(domain), pattern);
CREATE INDEX idx_domain_patterns_lookup ON domain_patterns (tenant_id, lower(domain));

-- Every prediction we have handed out. `outcome` is written back by the
-- inbox poller, and is what closes the learning loop: a hard bounce demotes
-- the format, a reply promotes it.
CREATE TABLE email_predictions (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  domain            TEXT        NOT NULL,
  input_name        TEXT        NOT NULL,
  first_name        TEXT        NOT NULL DEFAULT '',
  middle_name       TEXT        NOT NULL DEFAULT '',
  last_name         TEXT        NOT NULL DEFAULT '',
  predicted_email   TEXT        NOT NULL,
  pattern           TEXT        NOT NULL,
  confidence        NUMERIC(3,2) NOT NULL DEFAULT 0,
  band              TEXT        NOT NULL DEFAULT 'low'
                                CHECK (band IN ('high', 'medium', 'low')),
  seed_email        TEXT        NOT NULL DEFAULT '',
  contact_id        INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  outcome           TEXT        CHECK (outcome IS NULL OR outcome IN
                                ('delivered', 'replied', 'hard_bounce', 'soft_bounce')),
  outcome_at        TIMESTAMPTZ,
  created_by        INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_predictions_domain ON email_predictions (tenant_id, lower(domain));
CREATE INDEX idx_predictions_email ON email_predictions (lower(predicted_email));
-- Partial index: the poller only ever scans for predictions still awaiting
-- an outcome, and that set stays small while the table grows.
CREATE INDEX idx_predictions_pending ON email_predictions (tenant_id, created_at)
  WHERE outcome IS NULL;
