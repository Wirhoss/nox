-- The always-present memory an agent carries in its system prompt.
--
-- Deliberately a different table from `semantic_facts`, not a flag on one. A
-- fact is retrieved, dated, superseded and ranked; a block is none of those —
-- it is one current value, overwritten in place, that is in front of the model
-- whether or not the conversation went near it. Storing them together would
-- mean every query that means "what do I believe" having to remember to exclude
-- the rows that are not beliefs at all.
--
-- Scoped exactly like a fact, because a block holds what Nox has been told
-- about one person and must not cross to another.
CREATE TABLE semantic_blocks (
  agent_id    TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, issuer, subject, label)
);
