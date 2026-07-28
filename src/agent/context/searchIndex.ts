import { BM25 } from '../../utils';

import { formatHistoryMessage } from './format';
import { truncateMessageText } from './truncate';

import type { Message } from '../../provider';
import type { SessionSearchOptions } from './types';

// A fold carries no content of its own worth retrieving: the messages it folded
// are still in the transcript and already indexed, so indexing the summary too
// would return the same tool traffic twice.
function isIndexable(message: Message): boolean {
  if (message.role === 'fold') return false;
  if (message.role === 'reasoning') return false;
  if (message.role === 'compaction') return false;
  if (message.role === 'toolResponse') return message.execution !== 'deferredAck';
  if (message.role === 'assistant' || message.role === 'user') return message.content.length > 0;
  return true;
}

class MessageSearchIndex {
  private readonly messages: Message[];
  private readonly bm25: BM25;
  private readonly bm25IndexToMessage: Message[] = [];
  private readonly knownIds = new Set<string>();

  constructor(messages: Message[] = []) {
    this.messages = messages;

    const documents: string[] = [];
    for (const message of messages) {
      this.track(message);
      if (!isIndexable(message)) continue;
      documents.push(formatHistoryMessage(message));
      this.bm25IndexToMessage.push(message);
    }
    this.bm25 = new BM25(documents);
  }

  public get history(): readonly Message[] {
    return this.messages;
  }

  public append(message: Message): void {
    this.track(message);

    this.messages.push(message);
    if (!isIndexable(message)) return;
    this.bm25.addDocument(formatHistoryMessage(message));
    this.bm25IndexToMessage.push(message);
  }

  public search(
    query: string,
    activeHistory: readonly Message[],
    sessionSearchOptions: SessionSearchOptions = {},
  ): Message[] {
    const {
      limit = 5,
      sizeLimit = -1,
      avoidInCurrentHistory = true,
    } = sessionSearchOptions;

    const resultLimit = Math.max(0, Math.floor(limit));
    const documentCount = this.bm25.documentCount;

    if (resultLimit === 0 || documentCount === 0) {
      return [];
    }

    const activeMessageIds = avoidInCurrentHistory
      ? new Set(activeHistory.map((message) => message.messageId))
      : undefined;

    const retrievalSize = activeMessageIds
      ? Math.min(documentCount, resultLimit + activeMessageIds.size)
      : resultLimit;

    const results: Message[] = [];
    for (const { docIndex } of this.bm25.search(query, retrievalSize)) {
      if (results.length === resultLimit) break;

      const message = this.bm25IndexToMessage[docIndex];
      if (message === undefined) {
        throw new Error(`BM25 index ${docIndex} does not map to a message.`);
      }
      if (activeMessageIds?.has(message.messageId)) continue;

      results.push(truncateMessageText(message, sizeLimit));
    }

    return results;
  }

  private track(message: Message): void {
    if (this.knownIds.has(message.messageId)) {
      throw new Error(`Duplicate message id: ${message.messageId}.`);
    }
    this.knownIds.add(message.messageId);
  }
}

export {
  isIndexable,
  MessageSearchIndex,
};
