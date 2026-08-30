-- Pairs of facts consolidation has already put to the model.
--
-- The extractor only ever sees one turn against a window of recent beliefs, so
-- two statements that contradict each other while sitting far apart in time
-- never meet: nothing in the write path is ever looking at both at once. This
-- is where they meet, and this table is what stops that costing the same model
-- call again on every pass.
--
-- Recorded whatever the answer was, including "these do not contradict". A
-- verdict of no-contradiction is the expensive one to rediscover: it is the
-- common case, and without it the same unrelated neighbours would be re-asked
-- forever.
CREATE TABLE semantic_fact_contradictions (
  -- Ordered so a pair has one identity regardless of which side was examined.
  lower_fact_id   INTEGER NOT NULL REFERENCES semantic_facts (fact_id) ON DELETE CASCADE,
  higher_fact_id  INTEGER NOT NULL REFERENCES semantic_facts (fact_id) ON DELETE CASCADE,
  checked_at      TEXT NOT NULL,
  -- 'none', or the id of the fact the model said had ended.
  ended_fact_id   INTEGER REFERENCES semantic_facts (fact_id) ON DELETE SET NULL,
  PRIMARY KEY (lower_fact_id, higher_fact_id),
  CHECK (lower_fact_id < higher_fact_id)
);

CREATE INDEX semantic_fact_contradictions_higher
  ON semantic_fact_contradictions (higher_fact_id);
