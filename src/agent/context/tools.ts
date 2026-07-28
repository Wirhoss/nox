import { z } from 'zod';

import { ToolSet, type ImmediateTool } from '../../tool';

import type { Message } from '../../provider';
import type { SessionSearchOptions } from './types';

type SessionHistorySearch = (query: string, options?: SessionSearchOptions) => Message[];
type HistoryMessageFormatter = (message: Message) => string;

class SessionHistoryToolSet extends ToolSet {
  private readonly searchHistory: SessionHistorySearch;
  private readonly formatMessage: HistoryMessageFormatter;

  constructor(searchHistory: SessionHistorySearch, formatMessage: HistoryMessageFormatter) {
    super();

    this.searchHistory = searchHistory;
    this.formatMessage = formatMessage;

    const searchHistorySchema = z.object({
      query: z.string().trim().min(1).describe(
        'A short keyword query for the session transcript. Prefer exact anchors such as file paths, '
        + 'symbol names, error messages, commands, IDs, or quoted user wording.',
      ),
      limit: z.number().int().positive().default(5)
        .describe('Maximum number of matching messages to return.'),
      sizeLimit: z.number().int().min(-1).default(-1)
        .describe('Maximum text characters per returned message. Use -1 for no truncation.'),
    });

    const searchHistoryTool: ImmediateTool<typeof searchHistorySchema> = {
      type: 'immediate',
      name: 'search_session_history',
      description: 'Search the complete session transcript, including messages removed from the active context by folding or compaction. Use it to recover earlier facts, requirements, decisions, commands, errors, or exact identifiers.',
      parameters: searchHistorySchema,
      call: async ({ query, limit, sizeLimit }, _ctx) => this.searchHistory(query, {
        limit,
        sizeLimit,
      }).map((message) => ({
        type: 'text',
        text: this.formatMessage(message),
      })),
    };

    this._tools[searchHistoryTool.name] = searchHistoryTool;
  }
}

export {
  SessionHistoryToolSet,
};

export type {
  HistoryMessageFormatter,
  SessionHistorySearch,
};
