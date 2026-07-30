import { BM25 } from "../../utils";
import { contentToString, messageToString } from "../../provider";
import { ToolSet } from "../../tool";
import { z } from "zod";
import type { ImmediateTool } from "../../tool";
import type { Message, ToolResponseMessage } from "../../provider";

interface HistorySearchOptions {
  chunkSize?: number;
}

function isIndexable(message: Message): boolean {
  if (message.role === 'folded') return false;
  if (message.role === 'compacted') return false;
  if (message.role === 'toolResponse') return message.execution !== 'deferredAck';
  if (message.role === 'assistant' || message.role === 'user' || message.role === 'reasoning') return message.content.length > 0;
  return true;
}

const readToolResultSchema = z.object({
  trackId: z.string().describe(
    'The track ID of the tool call whose result you want, as shown in the `Track ID` field of the '
    + 'tool call or of its folded/compacted placeholder.',
  )
});

const searchHistorySchema = z.object({
  query: z.string().trim().min(1).describe(
    'A short keyword query for the session transcript. Prefer exact anchors such as file paths, '
    + 'symbol names, error messages, commands, IDs, or quoted user wording.',
  ),
  limit: z.number().int().min(1).max(20).default(5)
    .describe('Maximum number of transcript excerpts to return. Keep it small; raise it only when the first search comes back empty or off-target.')
});

class HistorySearch extends ToolSet {
  private _history: Message[];
  private chunks: string[] = [];
  private chunkSize: number;

  private toolResponses: Record<string, ToolResponseMessage> = {};

  private readonly bm25: BM25;

  constructor(messages: readonly Message[], historySearchOptions: HistorySearchOptions) {
    super();
    this._history = [...messages];
    this.chunkSize = historySearchOptions.chunkSize ?? 1000;
    this.chunks = messages.filter(isIndexable).flatMap((message) => this.chunkString(messageToString(message)));
    this.bm25 = new BM25(this.chunks);

    for (const message of messages) {
      if(message.role === 'toolResponse') {
        if (message.execution === 'deferredAck') continue;
        if (!this.toolResponses[message.trackId]) this.toolResponses[message.trackId] = message;
      }
    }

    this.addTools();
  }

  protected addTools(): void {
    const readToolResultTool: ImmediateTool<typeof readToolResultSchema> = {
      type: 'immediate',
      name: 'read_tool_result',
      description: 'Re-read the full result of an earlier tool call by its track ID. Use it when a tool result you need was folded or compacted out of the active context, or when you only kept a summary of it and now need the exact output.',
      parameters: readToolResultSchema,
      call: async ({ trackId }, _ctx) => {
        const message = this.toolResponses[trackId];
        if (!message) throw new Error(`No tool response found for track ID: ${trackId}`);
        return [{ type: 'text', text: messageToString(message) }];
      }
    };

    this._tools[readToolResultTool.name] = readToolResultTool;

    const searchHistoryTool: ImmediateTool<typeof searchHistorySchema> = {
      type: 'immediate',
      name: 'search_history',
      description: 'Keyword-search the complete session transcript, including messages removed from the active context by folding or compaction, and get back the best-matching excerpts. Use it to recover earlier facts, requirements, decisions, commands, errors, or exact identifiers instead of guessing or asking the user to repeat them.',
      parameters: searchHistorySchema,
      call: async ({ query, limit }, _ctx) => {
        const results = this.bm25.search(query, limit);
        const chunks = results.map((result) => this.chunks[result.docIndex])
        .filter(c => c !== undefined);
        return chunks.map((chunk) => ({ type: 'text', text: chunk }));
      }
    };

    this._tools[searchHistoryTool.name] = searchHistoryTool;
  }

  private chunkString(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + this.chunkSize, text.length);
      if (end < text.length) {
        const nl = text.indexOf('\n', end);
        if (nl !== -1 && nl - end <= this.chunkSize / 4) end = nl + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  public get history(): readonly Message[] {
    return this._history;
  }

  public append(message: Message): void {
    this._history.push(message);
    if (!isIndexable(message)) return;

    const chunks: string[] = [];
    if(message.role === 'assistant' || message.role === 'user' || message.role === 'reasoning') {
      const contentChunks = this.chunkString(contentToString(message.content));
      for(const [index, responseChunk] of contentChunks.entries()) {
        const chunk = `Role: ${message.role}\n`
        + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
        + `\nContent chunk number ${index} of ${contentChunks.length}`
        + `\nContent chunk:\n${responseChunk}`;
        chunks.push(chunk);
      }
    } else if(message.role === 'toolResponse') {
      const responseChunks = this.chunkString(contentToString(message.response));
      for(const [index, responseChunk] of responseChunks.entries()) {
        const chunk = `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}`
        + `\nExecution: ${message.execution}\nIs Error: ${message.isError ?? false}`
        + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
        + `\nResponse chunk number ${index} of ${responseChunks.length}`
        + `\nResponse chunk:\n${responseChunk}`;
        chunks.push(chunk);
      }
      if (!this.toolResponses[message.trackId]) this.toolResponses[message.trackId] = message;
    } else {
      chunks.push(messageToString(message));
    }

    for (const chunk of chunks) {
      this.chunks.push(chunk);
      this.bm25.addDocument(chunk);
    }
  }
}

export {
  HistorySearch,
}