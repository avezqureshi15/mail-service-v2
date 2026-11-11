-- Sending mailboxes, configured in the app rather than in .env.
--
-- Until now the service had exactly one mailbox, frozen into `env` at boot,
-- and every pacing counter was global because there was only ever one thing
-- to count. This migration introduces the mailbox as a first-class row and
-- re-keys the singleton tables that assumed there was only one.
--
-- Nothing here reads the new table yet - the seed-and-backfill step in
-- src/index.js populates it from the existing .env on first boot, so a
-- running deployment keeps sending across the upgrade. Every mailbox_id
-- column is therefore nullable here; a later migration tightens them once
-- the backfill is proven.

CREATE TABLE mailboxes (
  id                    SERIAL PRIMARY KEY,
  tenant_id             INTEGER     NOT NULL DEFAULT 1,
  -- Shown in the campaign wizard's sender picker, e.g. "Avez - Zoho".
  label                 TEXT        NOT NULL,
  provider              TEXT        NOT NULL DEFAULT 'other'
                                    CHECK (provider IN ('google', 'zoho', 'other')),
  -- Zoho runs regional data centres and the SPF include has to match the one
  -- the account lives in: smtp.zoho.in pairs with include:zoho.in.
  region                TEXT,

  from_name             TEXT        NOT NULL DEFAULT '',
  from_email            TEXT        NOT NULL,
  reply_to              TEXT        NOT NULL DEFAULT '',
  -- Normally from_email's domain. Kept as its own column because SPF, DKIM
  -- and the Message-ID are properties of the domain, and two mailboxes can
  -- legitimately share one.
  sending_domain        TEXT        NOT NULL,
  -- Per mailbox, not per domain: a Google mailbox and a Zoho mailbox can sit
  -- on the SAME sending domain and still need different selectors and
  -- different SPF includes. This is why domain_health below is keyed on the
  -- pair rather than on the domain alone.
  dkim_selector         TEXT        NOT NULL DEFAULT 'default',

  smtp_host             TEXT        NOT NULL,
  smtp_port             INTEGER     NOT NULL DEFAULT 465,
  smtp_user             TEXT        NOT NULL,
  -- AES-256-GCM, sealed by lib/secret-box.js under SECRETS_KEY. Never plain.
  smtp_password_cipher  TEXT        NOT NULL,

  -- IMAP drives bounce suppression and sequence reply-exit. A mailbox with
  -- it off still sends, but sends blind - so the delivery confirmer must
  -- refuse to read silence from it as success.
  imap_enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  imap_host             TEXT        NOT NULL DEFAULT '',
  imap_port             INTEGER     NOT NULL DEFAULT 993,
  imap_user             TEXT        NOT NULL DEFAULT '',
  imap_password_cipher  TEXT,
  imap_poll_seconds     INTEGER     NOT NULL DEFAULT 120 CHECK (imap_poll_seconds >= 30),

  -- Pacing. NULL means "derive from the provider preset", so a mailbox that
  -- has never been tuned follows providers.js rather than a copied number
  -- that silently goes stale when the preset is corrected.
  --
  -- perDomainHourlyCap is deliberately NOT here: it exists to stop one
  -- receiving domain seeing a burst, and the receiver attributes traffic
  -- from all our mailboxes to the same sending domain. Measuring globally
  -- but testing against N different thresholds would let the loosest
  -- mailbox defeat the cap for every other one. It stays in `settings`.
  daily_cap             INTEGER     CHECK (daily_cap IS NULL OR daily_cap > 0),
  hourly_cap            INTEGER     CHECK (hourly_cap IS NULL OR hourly_cap > 0),
  min_interval_seconds  INTEGER     CHECK (min_interval_seconds IS NULL OR min_interval_seconds > 0),
  jitter_percent        INTEGER     NOT NULL DEFAULT 60 CHECK (jitter_percent BETWEEN 0 AND 100),
  warmup_enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  warmup_started_on     DATE,
  -- Unlike the caps, the ramp is FROZEN at creation rather than re-derived.
  -- warmup_started_on only anchors the day index into it; if the preset
  -- changed mid-ramp a derived schedule would make the allowance jump, which
  -- is the exact volume step-change warm-up exists to avoid.
  warmup_schedule       JSONB,

  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  is_default            BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Set when the provider answers with a quota error. Pausing the MAILBOX
  -- rather than its campaigns is the better primitive: it heals itself at
  -- expiry, where a paused campaign needs a human to restart it.
  paused_until          TIMESTAMPTZ,
  pause_reason          TEXT,
  last_error            TEXT,
  last_verified_at      TIMESTAMPTZ,
  last_verify_error     TEXT,
  -- The transport pool's cache key. Bumped ONLY when host/port/user/password
  -- change - deliberately not updated_at, which also moves on last_error and
  -- paused_until writes. Keying the pool on updated_at would tear down a warm
  -- authenticated session on every failed send, which is precisely when
  -- re-authenticating against a throttling provider is most costly.
  config_version        INTEGER     NOT NULL DEFAULT 1,
  created_by            INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- IMAP on with nothing to connect with is a silent no-op, so refuse it.
  CONSTRAINT imap_configured_when_enabled CHECK (
    NOT imap_enabled
    OR (imap_host <> '' AND imap_user <> '' AND imap_password_cipher IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_mailboxes_label ON mailboxes (tenant_id, lower(label));
CREATE UNIQUE INDEX idx_mailboxes_from  ON mailboxes (tenant_id, lower(from_email));
-- At most one default per tenant, enforced by the database rather than by
-- remembering to clear the old one on every write.
CREATE UNIQUE INDEX idx_mailboxes_default ON mailboxes (tenant_id) WHERE is_default;
CREATE INDEX idx_mailboxes_active ON mailboxes (tenant_id, is_active);

-- --- Which mailbox sends what ----------------------------------------------

-- RESTRICT, not CASCADE or SET NULL: deleting a mailbox must never take a
-- campaign's history with it, and un-attributing historical sends would
-- corrupt the per-mailbox warm-up state. Mailboxes get deactivated.
ALTER TABLE campaigns ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE RESTRICT;
CREATE INDEX idx_campaigns_mailbox ON campaigns (mailbox_id);

-- Stamped when the job is queued rather than joined through campaigns, for
-- two reasons: the sender loop filters on it inside the same statement that
-- takes the row lock, and a campaign reassigned to another mailbox must not
-- retroactively rewrite who sent messages that already went out.
--
-- The cost of stamping is that reassignment has to re-stamp still-queued
-- rows explicitly; see the mailbox-change handling in routes/campaigns.js.
ALTER TABLE send_jobs ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE RESTRICT;
-- Supports the claim: the loop filters mailbox + status + due time.
CREATE INDEX idx_send_jobs_claim_mb ON send_jobs (mailbox_id, status, next_attempt_at);
-- Supports the per-mailbox hourly count.
CREATE INDEX idx_send_jobs_sent_mb  ON send_jobs (mailbox_id, status, sent_at);

-- Attribution for the inbox poller. These come from the matched send job, NOT
-- from the mailbox whose inbox the message landed in: a bounce for a message
-- sent by A can arrive at B when reply_to points there, and recording it
-- against B would show B with a terrible bounce rate having sent nothing.
ALTER TABLE bounces ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE SET NULL;
ALTER TABLE replies ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE SET NULL;

-- --- Re-keying the singletons ----------------------------------------------

-- Daily counter becomes per mailbox. The column is nullable and the primary
-- key becomes a unique index so today's existing count survives the
-- migration; the boot step attaches it to the seeded mailbox. Dropping and
-- recreating the table instead would reset the count to zero mid-day and let
-- the daily cap be exceeded on a live domain.
ALTER TABLE send_counters ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE CASCADE;
ALTER TABLE send_counters DROP CONSTRAINT send_counters_pkey;
CREATE UNIQUE INDEX idx_send_counters_mailbox_day ON send_counters (mailbox_id, day);

-- SPF/DKIM/DMARC state, keyed on the (domain, selector) PAIR rather than the
-- domain alone. Two mailboxes can share a sending domain while publishing
-- DKIM under different selectors and needing different SPF includes - a
-- Google mailbox wants selector `google` and include:_spf.google.com, a Zoho
-- one wants `zoho` and include:zoho.com. Keyed on domain only, whichever
-- mailbox checked last would decide whether the other was allowed to send.
--
-- Safe to recreate: it is a pure cache, re-derived by the sender within the
-- hour, so losing it costs one DNS lookup.
DROP TABLE domain_health;
CREATE TABLE domain_health (
  sending_domain    TEXT        NOT NULL,
  dkim_selector     TEXT        NOT NULL,
  spf_ok            BOOLEAN     NOT NULL DEFAULT FALSE,
  dkim_ok           BOOLEAN     NOT NULL DEFAULT FALSE,
  dmarc_ok          BOOLEAN     NOT NULL DEFAULT FALSE,
  detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  checked_at        TIMESTAMPTZ,
  PRIMARY KEY (sending_domain, dkim_selector)
);

-- The IMAP read position is NOT a cache, and this is the sharpest trap in the
-- migration. Lose last_uid and scanInbox() takes its first-run branch and
-- re-examines the last 7 days. Bounce and reply inserts are idempotent, but
-- the prediction events, pattern assertions, enrollment exits and unsubscribe
-- handling replayed alongside them are not - a contact manually un-suppressed
-- since would be re-suppressed. So the existing row is carried forward, not
-- recreated, and attached to the seeded mailbox at boot.
ALTER TABLE imap_state ADD COLUMN mailbox_id INTEGER REFERENCES mailboxes (id) ON DELETE CASCADE;
-- Backoff state, so a mailbox with a bad password cannot retry on a timer
-- until the provider locks the account.
ALTER TABLE imap_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imap_state ADD COLUMN last_error TEXT;
ALTER TABLE imap_state ADD COLUMN last_scan_at TIMESTAMPTZ;
-- Dropping the column takes its primary key and its CHECK (id = 1) with it,
-- and leaves the row - and therefore last_uid - intact.
ALTER TABLE imap_state DROP COLUMN id;
CREATE UNIQUE INDEX idx_imap_state_mailbox ON imap_state (mailbox_id, mailbox);
