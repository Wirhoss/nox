import { z } from 'zod';

import { contentToString, messageToString } from '../../provider';
import { ToolSet } from '../../tool';
import { BM25 } from '../../utils';

import type {
  Message,
  ToolCallMessage,
  ToolResponseMessage,
} from '../../provider';
import type { ImmediateTool } from '../../tool';

interface HistorySearchOptions {
  chunkSize?: number;
}

function isIndexable(message: Message): boolean {
  if (message.role === 'folded' || message.role === 'compacted') return false;
  if (message.role === 'toolResponse') return message.execution !== 'deferredAck';
  if (
    message.role === 'assistant'
    || message.role === 'user'
    || message.role === 'reasoning'
  ) {
    return message.content.some(
      (part) => part.type === 'image' || part.text.length > 0,
    );
  }
  return true;
}

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
  limit: z.number().int().min(1).max(20).default(5)
    .describe('Maximum number of transcript excerpts to return. Keep it small; raise it only when the first search comes back empty or off-target.'),
});

class HistorySearch extends ToolSet {
  private readonly bm25: BM25;
  private readonly chunkSize: number;
  private readonly chunks: string[] = [];
  private readonly knownIds = new Set<string>();
  private readonly toolResponses = new Map<string, ToolResponseMessage>();

  private readonly _history: Message[] = [];

  constructor(messages: readonly Message[], historySearchOptions: HistorySearchOptions) {
    super();

    this.chunkSize = historySearchOptions.chunkSize ?? 1000;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new RangeError('History search chunkSize must be a positive integer.');
    }

    for (const message of messages) {
      this.track(message);
      this._history.push(message);
      this.chunks.push(...this.chunksForMessage(message));
      this.rememberToolResponse(message);
    }

    this.bm25 = new BM25(this.chunks);
    this.addTools();
  }

  public get history(): readonly Message[] {
    return this._history;
  }

  public append(message: Message): void {
    this.track(message);
    this._history.push(message);
    this.rememberToolResponse(message);

    for (const chunk of this.chunksForMessage(message)) {
      this.chunks.push(chunk);
      this.bm25.addDocument(chunk);
    }
  }

  protected addTools(): void {
    const readToolResultTool: ImmediateTool<typeof readToolResultSchema> = {
      call: async ({ trackId, offset, maxCharacters }, _ctx) => {
        const message = this.toolResponses.get(trackId);
        if (message === undefined) {
          throw new Error(`No tool response found for track ID: ${trackId}`);
        }

        const formatted = messageToString(message);
        if (offset >= formatted.length && formatted.length > 0) {
          throw new RangeError(
            `Offset ${offset} is beyond tool result length ${formatted.length}.`,
          );
        }

        const end = Math.min(offset + maxCharacters, formatted.length);
        const continuation = end < formatted.length
          ? `\n\n[Result truncated. Continue with offset ${end}. Total characters: ${formatted.length}.]`
          : '';
        return [{
          text: formatted.slice(offset, end) + continuation,
          type: 'text',
        }];
      },
      description: 'Read an earlier tool result by track ID. Results are bounded; if the response reports a next offset, call the tool again from that offset.',
      name: 'read_tool_result',
      parameters: readToolResultSchema,
      type: 'immediate',
    };
    this._tools[readToolResultTool.name] = readToolResultTool;

    const searchHistoryTool: ImmediateTool<typeof searchHistorySchema> = {
      call: async ({ query, limit }, _ctx) => {
        const results = this.bm25.search(query, limit);
        return results.map(({ docIndex }) => {
          const chunk = this.chunks[docIndex];
          if (chunk === undefined) {
            throw new Error(`BM25 index ${docIndex} does not map to a history chunk.`);
          }
          return { text: chunk, type: 'text' };
        });
      },
      description: 'Keyword-search the complete session transcript, including messages removed from the active context by folding or compaction, and get back the best-matching excerpts. Use it to recover earlier facts, requirements, decisions, commands, errors, or exact identifiers instead of guessing or asking the user to repeat them.',
      name: 'search_history',
      parameters: searchHistorySchema,
      type: 'immediate',
    };
    this._tools[searchHistoryTool.name] = searchHistoryTool;
  }

  private chunkString(text: string): string[] {
    if (text.length === 0) return [''];

    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + this.chunkSize, text.length);
      if (end < text.length) {
        const newline = text.indexOf('\n', end);
        if (newline !== -1 && newline - end <= this.chunkSize / 4) end = newline + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  private chunksForMessage(message: Message): string[] {
    if (!isIndexable(message)) return [];

    if (
      message.role === 'assistant'
      || message.role === 'user'
      || message.role === 'reasoning'
    ) {
      const contentChunks = this.chunkString(contentToString(message.content));
      return contentChunks.map((contentChunk, index) => `Role: ${message.role}`
        + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
        + `\nContent chunk ${index + 1} of ${contentChunks.length}`
        + `\nContent:\n${contentChunk}`);
    }

    if (message.role === 'toolResponse') {
      const responseChunks = this.chunkString(contentToString(message.response));
      return responseChunks.map((responseChunk, index) => `Role: ${message.role}`
        + `\nName: ${message.name}\nTrack ID: ${message.trackId}`
        + `\nExecution: ${message.execution}\nIs Error: ${message.isError ?? false}`
        + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
        + `\nResponse chunk ${index + 1} of ${responseChunks.length}`
        + `\nResponse:\n${responseChunk}`);
    }

    if (message.role === 'toolCall') return this.toolCallChunks(message);
    return [];
  }

  private rememberToolResponse(message: Message): void {
    if (message.role !== 'toolResponse' || message.execution === 'deferredAck') return;
    if (!this.toolResponses.has(message.trackId)) {
      this.toolResponses.set(message.trackId, message);
    }
  }

  private toolCallChunks(message: ToolCallMessage): string[] {
    const argumentChunks = this.chunkString(JSON.stringify(message.arguments));
    return argumentChunks.map((argumentChunk, index) => `Role: ${message.role}`
      + `\nName: ${message.name}\nTrack ID: ${message.trackId}`
      + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
      + `\nArguments chunk ${index + 1} of ${argumentChunks.length}`
      + `\nArguments:\n${argumentChunk}`);
  }

  private track(message: Message): void {
    if (this.knownIds.has(message.messageId)) {
      throw new Error(`Duplicate message ID: ${message.messageId}.`);
    }
    this.knownIds.add(message.messageId);
  }
}

export {
  HistorySearch,
};
