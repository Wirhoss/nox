-- Before a session could name itself, the gateway stamped every conversation it
-- bound with `<brokerId>:<conversationId>`. That was never a name; it was a
-- placeholder in a column nothing read. Now that the column is shown to people
-- and a session names itself when it has none, those rows would both display an
-- id as their title and never be named. Clearing them puts them back where an
-- unnamed session belongs.
--
-- Matched against the binding rather than by pattern, so a session somebody
-- deliberately named after its conversation is the only false positive
-- possible, and it is one keystroke away from being named again.
UPDATE sessions
SET title = NULL
WHERE title IS NOT NULL
  AND title IN (
    SELECT conversations.broker_id || ':' || conversations.conversation_id
    FROM conversations
    WHERE conversations.session_id = sessions.session_id
  );
