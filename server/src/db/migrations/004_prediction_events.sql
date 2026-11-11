-- Append-only record of what happened to each predicted address.
--
-- `email_predictions.outcome` is written once and `predictionForEmail`
-- filters on it being NULL, so a bounce arriving after an earlier outcome
-- was silently dropped. Observations cannot be backfilled - a delivery
-- result you failed to record is gone - so this table exists before
-- anything scores against it.
--
-- The scoring that consumes this (posteriors, rollout states) is
-- deliberately not here. There is nothing yet to score; the point of
-- landing this now is to stop losing the data.

CREATE TABLE prediction_events (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER     NOT NULL DEFAULT 1,
  prediction_id  INTEGER     REFERENCES email_predictions (id) ON DELETE CASCADE,
  contact_id     INTEGER     REFERENCES contacts (id) ON DELETE SET NULL,
  email          TEXT        NOT NULL,
  event_type     TEXT        NOT NULL CHECK (event_type IN (
                               'sent', 'accepted', 'bounce', 'reply',
                               'complaint', 'auto_reply', 'manual')),
  -- Bounce detail; empty for everything else.
  reason         TEXT        NOT NULL DEFAULT '',
  dsn_status     TEXT        NOT NULL DEFAULT '',
  -- The tri-state from src/lib/bounce-reason.js.
  --   true  - the address is wrong, a format may be demoted
  --   false - nothing to do with the address (policy block, full mailbox)
  --   null  - unclear; recorded, but never acted on
  -- A disabled mailbox genuinely does not say whether the address was ever
  -- right, and collapsing that into either boolean destroys information the
  -- scorer will want.
  learns_address BOOLEAN,
  message_id     TEXT        NOT NULL DEFAULT '',
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_pred_events_prediction ON prediction_events (prediction_id);
CREATE INDEX idx_pred_events_email ON prediction_events (tenant_id, lower(email));
CREATE INDEX idx_pred_events_recent ON prediction_events (tenant_id, occurred_at DESC);

-- A mailbox re-read, or a provider sending the same DSN twice, must not
-- count as two bounces. Reports with no Message-ID are exempt rather than
-- collapsed together, since they cannot be told apart.
CREATE UNIQUE INDEX idx_pred_events_unique
  ON prediction_events (message_id, lower(email), event_type, dsn_status)
  WHERE message_id <> '';

-- The same detail on the existing bounce log, so campaign reporting can
-- distinguish "this address is wrong" from "we were blocked" without
-- joining through a prediction that may not exist.
ALTER TABLE bounces
  ADD COLUMN reason         TEXT NOT NULL DEFAULT '',
  ADD COLUMN dsn_status     TEXT NOT NULL DEFAULT '',
  ADD COLUMN learns_address BOOLEAN;
