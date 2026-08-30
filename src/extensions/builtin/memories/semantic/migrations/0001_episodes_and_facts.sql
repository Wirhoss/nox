-- The turn as it happened: cheap to write, never rewritten, and the provenance
-- every derived statement points back to. Extraction can fail, be improved, or
-- be run again with a better prompt; none of that may cost the record of what
-- was actually said.
CREATE TABLE semantic_episodes (
  episode_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  status        TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT NOT NULL,
  transcript    TEXT NOT NULL,
  extracted_at  TEXT
);

-- One run retained twice is the same episode. Retention is drained after a run
-- and can be retried, so the second attempt must not double the corpus.
CREATE UNIQUE INDEX semantic_episodes_run
  ON semantic_episodes (agent_id, issuer, subject, run_id);
CREATE INDEX semantic_episodes_scope
  ON semantic_episodes (agent_id, issuer, subject, completed_at);
-- Partial, because the queue is only ever the unextracted tail and it is read
-- far more often than it is long.
CREATE INDEX semantic_episodes_pending
  ON semantic_episodes (completed_at) WHERE extracted_at IS NULL;

-- What was learned, as a statement that can be retrieved on its own.
--
-- Bitemporal, and this is the whole point. `valid_from`/`valid_to` are when it
-- was true of the world; `created_at`/`invalidated_at` are when Nox believed it.
-- Someone who moved city has not made the old address false, they have ended
-- it: the earlier fact stays answerable for "where did I live before" while
-- being disqualified from "where do I live". A store that only deletes cannot
-- tell those apart, and one that only appends answers both at once.
CREATE TABLE semantic_facts (
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  text            TEXT NOT NULL,
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,
  created_at      TEXT NOT NULL,
  invalidated_at  TEXT,
  invalidated_by  INTEGER REFERENCES semantic_facts (fact_id) ON DELETE SET NULL,
  confidence      REAL NOT NULL
);

-- The index retrieval actually uses: one scope, still believed, newest first.
CREATE INDEX semantic_facts_live
  ON semantic_facts (agent_id, issuer, subject, created_at)
  WHERE invalidated_at IS NULL;
CREATE INDEX semantic_facts_scope
  ON semantic_facts (agent_id, issuer, subject, created_at);

-- Which episodes support a fact. Many-to-many because a fact stated twice is
-- one fact with two witnesses, and that is exactly what consolidation merges on.
CREATE TABLE semantic_fact_provenance (
  fact_id     INTEGER NOT NULL REFERENCES semantic_facts (fact_id) ON DELETE CASCADE,
  episode_id  INTEGER NOT NULL REFERENCES semantic_episodes (episode_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, episode_id)
);
CREATE INDEX semantic_fact_provenance_episode
  ON semantic_fact_provenance (episode_id);
