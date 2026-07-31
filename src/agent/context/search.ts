import { z } from 'zod';

import { ToolSet } from '../../tool';

import type { ImmediateTool } from '../../tool';
import type { Transcript } from './transcript';

const readToolResultSchema = z.object({
  trackId: z.string().describe(
    'The track ID of the tool call whose result you want, as shown in the `Track ID` field of the '
    + 'tool call or of its folded/compacted placeholder.',
  ),
  offset: z.number().int().min(0).default(0)
    .describe('Character offset at which to start reading the result.'),
  maxCharacters: z.number().int().min(200).max(4000).default(4000)
    .describe('Maximum characters to return. Continue from the reported next offset if truncated.'),
});

const searchHistorySchema = z.object({
  query: z.string().trim().min(1).describe(
    'A short keyword query for the session transcript. Prefer exact anchors such as file paths, '
    + 'symbol names, error messages, commands, IDs, or quoted user wording.',
  ),
  limit: z.number().int().min(1).max(10).default(5)
    .describe(
      'Maximum number of transcript excerpts to return. Keep it small; raise it only when the '
      + 'first search comes back empty or off-target.',
    ),
});

class HistorySearchToolSet extends ToolSet {
  readonly #transcript: Transcript;

  constructor(transcript: Transcript) {
    super();
    this.#transcript = transcript;
    this.addTools();
  }

  protected addTools(): void {
    const readToolResult: ImmediateTool<typeof readToolResultSchema> = {
      call: async ({ trackId, offset, maxCharacters }) => (
        this.#transcript.readToolResult(trackId, offset, maxCharacters)
      ),
      description: 'Read an earlier tool result by track ID. Results are bounded; if the response '
        + 'reports a next offset, call the tool again from that offset.',
      name: 'read_tool_result',
      parameters: readToolResultSchema,
      type: 'immediate',
    };
    this.registerTool(readToolResult);

    const searchHistory: ImmediateTool<typeof searchHistorySchema> = {
      call: async ({ query, limit }) => this.#transcript.search(query, limit),
      description: 'Keyword-search the complete session transcript, including messages removed '
        + 'from the active context by folding or compaction, and get back the best-matching '
        + 'excerpts. Use it to recover earlier facts, requirements, decisions, commands, errors, '
        + 'or exact identifiers instead of guessing or asking the user to repeat them.',
      name: 'search_history',
      parameters: searchHistorySchema,
      type: 'immediate',
    };
    this.registerTool(searchHistory);
  }
}

export {
  HistorySearchToolSet,
};
