import { z } from 'zod';

import { HISTORY_READ_AUTHORITY, HISTORY_SEARCH_AUTHORITY } from '../../auth/coreAuthorities';
import { bindTool, type Tool, ToolSet } from '../../tool/tool';

import type { Transcript } from './transcript';

const readToolResultSchema = z.object({
  maxCharacters: z
    .number()
    .int()
    .min(200)
    .max(4000)
    .default(4000)
    .describe('Maximum characters to return. Continue from the reported next offset if truncated.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset at which to start reading the result.'),
  trackId: z
    .string()
    .describe(
      'The track ID of the tool call whose result you want, as shown in the `Track ID` field ' +
        'of the tool call or of its folded/compacted placeholder.',
    ),
});

/**
 * These two are handed to the model by the context itself rather than granted
 * from a blueprint, so nothing else would ever bind them to a set. They bind
 * themselves — without a subject they could not be authorized at all.
 */
const HISTORY_TOOL_SET_ID = 'nox.history';

const searchHistorySchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe(
      'Maximum number of transcript excerpts to return. Keep it small; raise it only when the ' +
        'first search comes back empty or off-target.',
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'A short keyword query for the session transcript. Prefer exact anchors such as file ' +
        'paths, symbol names, error messages, commands, IDs, or quoted user wording.',
    ),
});

class HistorySearchToolSet extends ToolSet {
  readonly #transcript: Transcript;

  constructor(transcript: Transcript) {
    super('history_search', 'Searches and reads the complete session transcript.');
    this.#transcript = transcript;
    this.addTools();
  }

  protected addTools(): void {
    const readToolResult: Tool<typeof readToolResultSchema> = {
      authority: HISTORY_READ_AUTHORITY,
      description:
        'Read an earlier tool result by track ID. Results are bounded; if the response ' +
        'reports a next offset, call the tool again from that offset.',
      name: 'read_tool_result',
      parameters: readToolResultSchema,
      prepare: ({ trackId, offset, maxCharacters }) => ({
        run: () => Promise.resolve(this.#transcript.readToolResult(trackId, offset, maxCharacters)),
        title: `Read tool result — ${trackId}`,
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(readToolResult, HISTORY_TOOL_SET_ID));

    const searchHistory: Tool<typeof searchHistorySchema> = {
      authority: HISTORY_SEARCH_AUTHORITY,
      description:
        'Keyword-search the complete session transcript, including messages removed ' +
        'from the active context by folding or compaction, and get back the best-matching ' +
        'excerpts. Use it to recover earlier facts, requirements, decisions, commands, errors, ' +
        'or exact identifiers instead of guessing or asking the user to repeat them.',
      name: 'search_history',
      parameters: searchHistorySchema,
      prepare: ({ query, limit }) => ({
        run: () => Promise.resolve(this.#transcript.search(query, limit)),
        title: `Search history — ${query}`,
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(searchHistory, HISTORY_TOOL_SET_ID));
  }
}

export { HistorySearchToolSet };
