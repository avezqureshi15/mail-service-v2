-- Preheader (inbox preview text) per campaign and per sequence step, mirroring
-- how subject already works: a step's own value wins, an empty one falls
-- back to the campaign's.
ALTER TABLE campaigns       ADD COLUMN preheader TEXT NOT NULL DEFAULT '';
ALTER TABLE sequence_steps  ADD COLUMN preheader TEXT NOT NULL DEFAULT '';
