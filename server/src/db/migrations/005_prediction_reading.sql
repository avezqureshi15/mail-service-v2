-- How the name was read, recorded alongside the prediction it produced.
--
-- A bounce on `qureshi@` could mean the company does not use `last`, or it
-- could mean we picked the wrong word as the surname. Those call for
-- opposite corrections - demote the format, or distrust the reading - and
-- after the fact they are indistinguishable without knowing how confident
-- the reading was at the time.
--
-- This is the input to two later decisions, both of which become
-- unanswerable if it is not captured now:
--
--   * §5.3 attribution - charge a bounce to the format or to the reading.
--   * §7 Call 2 - whether an LLM tie-break on ambiguous readings is worth
--     building, which is only decidable by measuring how much of the error
--     those readings actually cause.
--
-- The values are already computed on every prediction and were being
-- thrown away. Three columns, and the alternative is guessing later.

ALTER TABLE email_predictions
  -- 'clean' | 'ambiguous' - the parser's own verdict on the split.
  ADD COLUMN name_confidence TEXT NOT NULL DEFAULT '',
  -- 'rules' | 'model' - whether a language model was consulted for it.
  ADD COLUMN name_source     TEXT NOT NULL DEFAULT '',
  -- Distinct non-speculative candidates this person produced. 1 means one
  -- plausible answer; higher means the reading or the format was contested,
  -- and it is what drove the confidence band.
  ADD COLUMN reading_count   INTEGER NOT NULL DEFAULT 1;

-- The question these exist to answer: of the bounces that blamed the
-- address, how many were on a shaky reading rather than a wrong format?
CREATE INDEX idx_predictions_reading
  ON email_predictions (tenant_id, name_confidence)
  WHERE name_confidence <> '';
