-- How many independent seeds have claimed a format.
--
-- Distinct from `confirmed_count`, which counts delivery. This counts
-- operators telling us, and it is what lets a prefixed format - `ts-|first-last`
-- for ts-syed-baseer@rakuten.com - wait for corroboration.
--
-- One address starting `ts-` cannot distinguish a company-wide prefix from
-- a marker on one person: `ts` might be every Rakuten mailbox, or it might
-- mean contractor. Guessing the first would prefix every colleague wrongly.
-- Two independent addresses sharing it is real evidence; one is not. So a
-- prefixed format is recorded on the first seed but stays out of use until
-- a second asserts it, or a delivery confirms it.
--
-- Plain formats are unaffected: a single seed has always been enough for
-- them, because the format is visible in the address itself rather than
-- inferred from something left over.

ALTER TABLE domain_patterns
  ADD COLUMN asserted_count INTEGER NOT NULL DEFAULT 1;
