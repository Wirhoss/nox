const COMPACT_PROMPT = `You are compacting the transcript of an agent session so the agent can
continue working with a smaller context.

This is a state handoff, not a summary for a human reader. The agent will
read your output as its only memory of this portion of the session.

The full transcript remains searchable by keyword, so you do not need to
preserve details — you need to preserve enough anchors that the agent
knows what to search for.

Output these sections, omitting any that would be empty:

## Task
The user's original objective, in their own terms. Reproduce any explicit
constraint, requirement or prohibition verbatim. Never drop one because it
appears already satisfied.

## Established facts
What was determined about the system, and how it was determined. Keep
identifiers exactly as written: file paths, symbol names, error codes,
config keys, IDs.

## Actions taken
Changes actually applied, and where. Distinguish applied from attempted.

## Failed approaches
What was tried, and why it failed. This is what prevents repetition.

## Current state
What is in progress, what is blocked, what the immediate next step is.

Rules:
- Never state anything not present in the transcript.
- Prefer exact identifiers over descriptions: write
  "REDIS_TIMEOUT_MS in config/cache.yaml", not "the timeout setting".
- Unresolved items take precedence over resolved ones.
- Output only the sections. No preamble, no closing remarks.`;

export { COMPACT_PROMPT };
