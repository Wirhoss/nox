-- Agentic corrections and retirements are auditable episodes too. A replacement
-- already points at the new fact through invalidated_by; this second edge records
-- the operation episode that caused either a replacement or a retirement with no
-- successor.
ALTER TABLE semantic_facts
  ADD COLUMN invalidated_episode_id INTEGER
    REFERENCES semantic_episodes (episode_id) ON DELETE SET NULL;

CREATE INDEX semantic_facts_invalidation_episode
  ON semantic_facts (invalidated_episode_id)
  WHERE invalidated_episode_id IS NOT NULL;
