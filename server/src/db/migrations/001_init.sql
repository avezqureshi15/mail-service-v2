-- Core schema. Every top-level table carries tenant_id so that scoping data
-- per client later is a query change, not a data migration on a populated
-- contacts table.
--
-- Postgres notes, since this was ported from SQLite:
--  * Flags are real BOOLEANs rather than 0/1 integers. Besides being correct,
--    it removes a whole class of React bug where `{row.is_sequence && ...}`
--    rendered a literal "0" on screen.
--  * Timestamps are TIMESTAMPTZ defaulting to now(), so ordering and interval
--    arithmetic work without string comparisons.
--  * Case-insensitive uniqueness uses an index on lower(...), which is the
--    portable equivalent of SQLite's COLLATE NOCASE.

CREATE TABLE users (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  email             TEXT        NOT NULL,
  name              TEXT        NOT NULL DEFAULT '',
  password_hash     TEXT        NOT NULL,
  role              TEXT        NOT NULL DEFAULT 'sender' CHECK (role IN ('admin', 'sender')),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_users_email ON users (tenant_id, lower(email));

CREATE TABLE contacts (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  email             TEXT        NOT NULL,
  first_name        TEXT        NOT NULL DEFAULT '',
  last_name         TEXT        NOT NULL DEFAULT '',
  company           TEXT        NOT NULL DEFAULT '',
  -- Arbitrary extra CSV columns, exposed as merge fields.
  custom_fields     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- 'active' contacts are mailable; the suppressions table is still the
  -- authority checked at send time.
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'unsubscribed', 'bounced', 'complained')),
  is_role_account   BOOLEAN     NOT NULL DEFAULT FALSE,
  source            TEXT        NOT NULL DEFAULT 'import',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_contacts_email ON contacts (tenant_id, lower(email));
CREATE INDEX idx_contacts_status ON contacts (tenant_id, status);

CREATE TABLE lists (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  name              TEXT        NOT NULL,
  description       TEXT        NOT NULL DEFAULT '',
  created_by        INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_lists_name ON lists (tenant_id, lower(name));

CREATE TABLE list_contacts (
  list_id           INTEGER     NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  contact_id        INTEGER     NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX idx_list_contacts_contact ON list_contacts (contact_id);

CREATE TABLE campaigns (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  name              TEXT        NOT NULL,
  list_id           INTEGER     REFERENCES lists (id) ON DELETE SET NULL,
  subject           TEXT        NOT NULL DEFAULT '',
  html_body         TEXT        NOT NULL DEFAULT '',
  from_name         TEXT        NOT NULL DEFAULT '',
  from_email        TEXT        NOT NULL DEFAULT '',
  reply_to          TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled')),
  -- Off by default: pixels and rewritten links cost inbox placement.
  tracking_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_sequence       BOOLEAN     NOT NULL DEFAULT FALSE,
  scheduled_at      TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  pause_reason      TEXT,
  created_by        INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_status ON campaigns (tenant_id, status);

-- Step 1 is the initial send; steps 2+ are follow-ups. A non-sequence campaign
-- has exactly one row here, which keeps the sender worker uniform.
CREATE TABLE sequence_steps (
  id                SERIAL PRIMARY KEY,
  campaign_id       INTEGER     NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  step_no           INTEGER     NOT NULL,
  wait_days         INTEGER     NOT NULL DEFAULT 0,
  subject           TEXT        NOT NULL DEFAULT '',
  html_body         TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_sequence_steps_order ON sequence_steps (campaign_id, step_no);

CREATE TABLE sequence_enrollments (
  id                SERIAL PRIMARY KEY,
  campaign_id       INTEGER     NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id        INTEGER     NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  current_step      INTEGER     NOT NULL DEFAULT 0,
  next_run_at       TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'completed', 'exited')),
  exit_reason       TEXT        CHECK (exit_reason IS NULL OR exit_reason IN
                                ('replied', 'unsubscribed', 'bounced', 'complained', 'stopped')),
  -- Message-ID of the step-1 send, so follow-ups thread onto the original.
  thread_message_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_enrollments_unique ON sequence_enrollments (campaign_id, contact_id);
CREATE INDEX idx_enrollments_due ON sequence_enrollments (status, next_run_at);

-- The send queue. One row per message attempt.
CREATE TABLE send_jobs (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  campaign_id       INTEGER     NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id        INTEGER     NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  step_no           INTEGER     NOT NULL DEFAULT 1,
  -- Denormalised so per-domain pacing does not need a join on the hot path.
  recipient_domain  TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts          INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at         TIMESTAMPTZ,
  message_id        TEXT,
  error             TEXT,
  skip_reason       TEXT,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_send_jobs_unique ON send_jobs (campaign_id, contact_id, step_no);
CREATE INDEX idx_send_jobs_claim ON send_jobs (status, next_attempt_at);
CREATE INDEX idx_send_jobs_message ON send_jobs (message_id);
CREATE INDEX idx_send_jobs_campaign ON send_jobs (campaign_id, status);

-- Global and permanent. Checked inside the job-claim transaction, so an
-- unsubscribe landing mid-campaign is honoured for the rest of the run.
CREATE TABLE suppressions (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  email             TEXT        NOT NULL,
  reason            TEXT        NOT NULL CHECK (reason IN
                                ('unsubscribed', 'hard_bounce', 'soft_bounce_limit', 'complaint', 'manual', 'invalid')),
  source            TEXT        NOT NULL DEFAULT '',
  notes             TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_suppressions_email ON suppressions (tenant_id, lower(email));

CREATE TABLE unsubscribes (
  id                SERIAL PRIMARY KEY,
  contact_id        INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id       INTEGER     REFERENCES campaigns (id) ON DELETE SET NULL,
  email             TEXT        NOT NULL,
  -- 'one_click' is the RFC 8058 header POST; 'link' is the footer link.
  method            TEXT        NOT NULL DEFAULT 'link'
                                CHECK (method IN ('link', 'one_click', 'mailto', 'manual')),
  ip                TEXT        NOT NULL DEFAULT '',
  user_agent        TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_unsubscribes_email ON unsubscribes (lower(email));

CREATE TABLE bounces (
  id                SERIAL PRIMARY KEY,
  message_id        TEXT,
  contact_id        INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id       INTEGER     REFERENCES campaigns (id) ON DELETE SET NULL,
  email             TEXT        NOT NULL DEFAULT '',
  bounce_type       TEXT        NOT NULL CHECK (bounce_type IN ('hard', 'soft', 'complaint', 'unknown')),
  smtp_code         TEXT        NOT NULL DEFAULT '',
  diagnostic        TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bounces_message ON bounces (message_id);
CREATE INDEX idx_bounces_created ON bounces (created_at);
-- One delivery report counts once: a re-read message or a duplicate DSN would
-- otherwise inflate the bounce rate that auto-pauses sending.
CREATE UNIQUE INDEX idx_bounces_unique ON bounces (message_id, email, bounce_type);

CREATE TABLE replies (
  id                SERIAL PRIMARY KEY,
  contact_id        INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id       INTEGER     REFERENCES campaigns (id) ON DELETE SET NULL,
  in_reply_to       TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL DEFAULT '',
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_replies_contact ON replies (contact_id, campaign_id);

CREATE TABLE tracking_events (
  id                SERIAL PRIMARY KEY,
  message_id        TEXT        NOT NULL,
  contact_id        INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  campaign_id       INTEGER     REFERENCES campaigns (id) ON DELETE SET NULL,
  event_type        TEXT        NOT NULL CHECK (event_type IN ('open', 'click')),
  url               TEXT        NOT NULL DEFAULT '',
  user_agent        TEXT        NOT NULL DEFAULT '',
  ip                TEXT        NOT NULL DEFAULT '',
  -- Scanner and prefetch traffic is recorded but excluded from headline stats.
  is_bot            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tracking_campaign ON tracking_events (campaign_id, event_type, is_bot);
CREATE INDEX idx_tracking_message ON tracking_events (message_id);

CREATE TABLE settings (
  key               TEXT        PRIMARY KEY,
  value             TEXT        NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per calendar day, so the daily cap survives a restart.
CREATE TABLE send_counters (
  day               DATE    PRIMARY KEY,
  sent_count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE domain_health (
  id                INTEGER     PRIMARY KEY CHECK (id = 1),
  spf_ok            BOOLEAN     NOT NULL DEFAULT FALSE,
  dkim_ok           BOOLEAN     NOT NULL DEFAULT FALSE,
  dmarc_ok          BOOLEAN     NOT NULL DEFAULT FALSE,
  detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  checked_at        TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  action            TEXT        NOT NULL,
  entity            TEXT        NOT NULL DEFAULT '',
  entity_id         INTEGER,
  detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_log (created_at);

-- Tracks how far the inbox poller has read.
--
-- Positioned by IMAP UID rather than by read state: a person's real mailbox
-- has thousands of unread messages, so searching unread finds the oldest
-- first and never reaches today's bounces. UIDs only increase, so "above the
-- last one handled" is exactly the new mail, read or not - and nothing in
-- the mailbox has to be modified to keep the bookmark.
CREATE TABLE imap_state (
  id           INTEGER     PRIMARY KEY CHECK (id = 1),
  mailbox      TEXT        NOT NULL DEFAULT 'INBOX',
  -- If the server reports a different uid_validity the old UIDs are
  -- meaningless and the position has to be re-established.
  uid_validity TEXT,
  last_uid     BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO imap_state (id, mailbox, last_uid) VALUES (1, 'INBOX', 0);

-- Campaign categories: an organisational label, not a sending concept.
-- Nothing about sending, suppression, pacing or warm-up reads these tables.
CREATE TABLE campaign_categories (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER     NOT NULL DEFAULT 1,
  name              TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_campaign_categories_name
  ON campaign_categories (tenant_id, lower(name));

CREATE TABLE sub_categories (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER     NOT NULL DEFAULT 1,
  category_id INTEGER     NOT NULL REFERENCES campaign_categories (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_sub_categories_name
  ON sub_categories (tenant_id, category_id, lower(name));
CREATE INDEX idx_sub_categories_category ON sub_categories (tenant_id, category_id);

ALTER TABLE campaigns
  ADD COLUMN category_id INTEGER REFERENCES campaign_categories (id) ON DELETE RESTRICT,
  ADD COLUMN sub_category_id INTEGER REFERENCES sub_categories (id) ON DELETE SET NULL;

CREATE INDEX idx_campaigns_category ON campaigns (tenant_id, category_id);
CREATE INDEX idx_campaigns_sub_category ON campaigns (tenant_id, sub_category_id);

-- Every tenant gets a default bucket so a campaign always belongs to one.
INSERT INTO campaign_categories (tenant_id, name) VALUES (1, 'Uncategorised');
