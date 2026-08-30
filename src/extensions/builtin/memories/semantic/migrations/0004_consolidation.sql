-- Which facts consolidation has already looked at.
--
-- A queue rather than a rescan, for the same reason episodes have one: the
-- corpus only grows, and re-examining every fact on every pass would make the
-- cheapest part of the background work the most expensive one.
--
-- Marking each fact once is enough to find every duplicate, because a duplicate
-- is always discovered from the newer side: the fact that arrives second is the
-- one still unconsolidated, and its neighbour search reaches the older
-- statement whether or not that one has been examined before.
ALTER TABLE semantic_facts ADD COLUMN consolidated_at TEXT;

-- Partial, like the episode queue: what is read is the unconsolidated tail, and
-- it is read far more often than it is long.
CREATE INDEX semantic_facts_unconsolidated
  ON semantic_facts (created_at)
  WHERE consolidated_at IS NULL AND invalidated_at IS NULL;
