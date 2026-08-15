import { createLogger } from '../../logger';
import { contentToString, messageToString } from '../../provider';
import { BM25 } from '../../utils';

import { freezeMessage } from './immutable';
import { assertPositiveInteger } from './validate';

import type {
  Message,
  MessageContentText,
  ToolResponseMessage,
} from '../../provider';

interface TranscriptOptions {
  chunkSize?: number;
  maxSearchCharacters?: number;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_MAX_SEARCH_CHARACTERS = 6000;
const SEARCH_BUDGET_NOTE = '[More matches were omitted to stay within the history-search response budget. Narrow the query with a more exact keyword, path, symbol, error, or ID.]';

const logger = createLogger('agent:context:transcript');

function isIndexable(message: Message): boolean {
  switch (message.role) {
    case 'compacted':
    case 'folded':
      return false;
    case 'toolResponse':
      return message.execution !== 'deferredAck';
    case 'assistant':
    case 'reasoning':
    case 'user':
      return message.content.some((part) => part.type === 'image' || part.text.length > 0);
    case 'toolCall':
      return true;
  }
}

class Transcript {
  readonly #bm25: BM25;
  readonly #chunkSize: number;
  readonly #maxSearchCharacters: number;

  readonly #chunks: string[] = [];
  readonly #messages: Message[] = [];
  readonly #knownIds = new Set<string>();
  readonly #duplicateMessageIds: string[] = [];
  readonly #toolResponses = new Map<string, ToolResponseMessage>();

  #snapshot?: readonly Message[];

  constructor(messages: readonly Message[] = [], options: TranscriptOptions = {}) {
    this.#chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.#maxSearchCharacters = options.maxSearchCharacters ?? DEFAULT_MAX_SEARCH_CHARACTERS;
    assertPositiveInteger(this.#chunkSize, 'chunkSize');
    assertPositiveInteger(this.#maxSearchCharacters, 'maxSearchCharacters');

    for (const message of messages) {
      if (this.#knownIds.has(message.messageId)) {
        this.#duplicateMessageIds.push(message.messageId);
        logger.warn(
          { messageId: message.messageId },
          'Skipping duplicate persisted message while rebuilding the transcript.',
        );
        continue;
      }
      this.#record(freezeMessage(message));
    }

    this.#bm25 = new BM25(this.#chunks);
  }

  public get messages(): readonly Message[] {
    this.#snapshot ??= Object.freeze([...this.#messages]);
    return this.#snapshot;
  }

  public get duplicateMessageIds(): readonly string[] {
    return Object.freeze([...this.#duplicateMessageIds]);
  }

  public append(message: Message): Message {
    const frozen = freezeMessage(message);
    if (this.#knownIds.has(frozen.messageId)) {
      throw new Error(`Duplicate message ID: ${frozen.messageId}.`);
    }

    const firstNewChunk = this.#chunks.length;
    this.#record(frozen);
    for (let index = firstNewChunk; index < this.#chunks.length; index++) {
      this.#indexChunk(index);
    }

    this.#snapshot = undefined;
    return frozen;
  }

  public readToolResult(
    trackId: string,
    offset: number,
    maxCharacters: number,
  ): MessageContentText[] {
    const message = this.#toolResponses.get(trackId);
    if (message === undefined) {
      throw new Error(`No tool response found for track ID: ${trackId}`);
    }

    const formatted = messageToString(message);
    if (offset >= formatted.length && formatted.length > 0) {
      throw new RangeError(`Offset ${offset} is beyond tool result length ${formatted.length}.`);
    }

    const end = Math.min(offset + maxCharacters, formatted.length);
    const continuation = end < formatted.length
      ? `\n\n[Result truncated. Continue with offset ${end}. Total characters: ${formatted.length}.]`
      : '';
    return [{
      text: formatted.slice(offset, end) + continuation,
      type: 'text',
    }];
  }

  public search(query: string, limit: number): MessageContentText[] {
    const hits: MessageContentText[] = [];
    let characterCount = 0;
    let omitted = false;

    for (const { docIndex } of this.#bm25.search(query, limit)) {
      const chunk = this.#chunks[docIndex];
      if (chunk === undefined) {
        throw new Error(`BM25 index ${docIndex} does not map to a transcript chunk.`);
      }
      if (characterCount + chunk.length > this.#maxSearchCharacters) {
        omitted = true;
        break;
      }
      hits.push({ text: chunk, type: 'text' });
      characterCount += chunk.length;
    }

    if (omitted) this.#appendBudgetNote(hits, characterCount);
    return hits;
  }

  #appendBudgetNote(hits: MessageContentText[], usedCharacters: number): void {
    let characterCount = usedCharacters;
    while (
      hits.length > 0
      && characterCount + SEARCH_BUDGET_NOTE.length > this.#maxSearchCharacters
    ) {
      characterCount -= hits.pop()?.text.length ?? 0;
    }
    hits.push({
      text: SEARCH_BUDGET_NOTE.slice(0, this.#maxSearchCharacters - characterCount),
      type: 'text',
    });
  }

  #chunkString(text: string): string[] {
    if (text.length === 0) return [''];

    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + this.#chunkSize, text.length);
      if (end < text.length) {
        const newline = text.indexOf('\n', end);
        if (newline !== -1 && newline - end <= this.#chunkSize / 4) end = newline + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  #chunksForMessage(message: Message): string[] {
    if (!isIndexable(message)) return [];

    if (message.role === 'toolCall') {
      return this.#renderChunks(
        JSON.stringify(message.arguments),
        (chunk, position) => `Role: ${message.role}`
          + `\nName: ${message.name}\nTrack ID: ${message.trackId}`
          + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
          + `\nArguments chunk ${position}`
          + `\nArguments:\n${chunk}`,
      );
    }

    if (message.role === 'toolResponse') {
      return this.#renderChunks(
        contentToString(message.response),
        (chunk, position) => `Role: ${message.role}`
          + `\nName: ${message.name}\nTrack ID: ${message.trackId}`
          + `\nExecution: ${message.execution}\nIs Error: ${message.isError ?? false}`
          + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
          + `\nResponse chunk ${position}`
          + `\nResponse:\n${chunk}`,
      );
    }

    return this.#renderChunks(
      contentToString(message.content),
      (chunk, position) => `Role: ${message.role}`
        + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
        + `\nContent chunk ${position}`
        + `\nContent:\n${chunk}`,
    );
  }

  #indexChunk(index: number): void {
    const chunk = this.#chunks[index];
    if (chunk === undefined) {
      throw new Error(`Transcript chunk ${index} is missing.`);
    }

    const docIndex = this.#bm25.addDocument(chunk);
    if (docIndex !== index) {
      throw new Error(
        `BM25 document index ${docIndex} does not match transcript chunk index ${index}.`,
      );
    }
  }

  #record(message: Message): void {
    this.#knownIds.add(message.messageId);
    this.#messages.push(message);
    this.#chunks.push(...this.#chunksForMessage(message));

    if (message.role === 'toolResponse'
      && message.execution !== 'deferredAck'
      && !this.#toolResponses.has(message.trackId)) {
      this.#toolResponses.set(message.trackId, message);
    }
  }

  #renderChunks(text: string, render: (chunk: string, position: string) => string): string[] {
    const chunks = this.#chunkString(text);
    return chunks.map((chunk, index) => render(chunk, `${index + 1} of ${chunks.length}`));
  }
}

export {
  Transcript,
};

export type {
  TranscriptOptions,
};
