-- Recall is a ranking signal rather than part of the fact itself. Counts are
-- accumulated in memory and flushed in batches, so reading five facts does not
-- turn a read path into five durable writes. Losing the unflushed tail after a
-- crash loses only a hint; provenance and the fact remain untouched.
ALTER TABLE semantic_facts
  ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0);

ALTER TABLE semantic_facts
  ADD COLUMN last_accessed_at TEXT;
