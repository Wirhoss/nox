import { nanoid } from 'nanoid';

import { applyCompaction, seekSafeCut } from './compact';
import { applyFold, foldHistory } from './fold';
import { COMPACT_PROMPT } from './prompt';
import { HistorySearch } from './search';

import type {
  AssistantMessage,
  ChatProvider,
  CompactedMessage,
  Message,
} from '../../provider';
import type { Tool } from '../../tool';

interface ContextOptions {
  fullHistory?: Message[];
  tools?: Record<string, Tool>;

  compactGuardBeginning?: number;
  compactGuardEnd?: number;
  compactMinMessages?: number;
}

class Context {
  private readonly systemPrompt: string;
  private readonly tools: Map<string, Tool>;

  private readonly compactProvider: ChatProvider;
  private readonly compactGuardBeginning: number;
  private readonly compactGuardEnd: number;
  private readonly compactMinMessages: number;

  private searchHistory: HistorySearch;

  private messageHistory: Message[];

  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(systemPrompt: string, compactProvider: ChatProvider, contextOptions: ContextOptions) {
    this.systemPrompt = systemPrompt;
    this.compactProvider = compactProvider;
    this.compactGuardBeginning = contextOptions.compactGuardBeginning ?? 5;
    this.compactGuardEnd = contextOptions.compactGuardEnd ?? 5;
    this.compactMinMessages = contextOptions.compactMinMessages ?? 10;
    this.searchHistory = new HistorySearch(contextOptions.fullHistory ?? [], { chunkSize: 1000 });
    this.tools = new Map<string, Tool>(
      Object.entries(contextOptions.tools ?? {}).sort((a, b) => a[0].localeCompare(b[0]))
    );
    this.messageHistory = this.rebuildHistory(contextOptions.fullHistory ?? []);
  }

  private serializeMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation);

    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  public getFullHistory(): readonly Message[] {
    return this.searchHistory.history;
  }

  public getHistory(): readonly Message[] {
    return this.messageHistory;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public getTools(): Map<string, Tool> {
    return this.tools;
  }

  public getHistorySearchToolSet(): HistorySearch {
    return this.searchHistory;
  }

  public addMessage(message: Message): void {
    const frozen = Object.freeze(message);
    this.searchHistory.append(frozen);
    this.messageHistory.push(frozen);
  }

  public async fold(fromMessageId?: string, toMessageId?: string): Promise<void> {
    return this.serializeMutation(() => {
      const { events, history } = foldHistory(this.messageHistory, fromMessageId, toMessageId);
      if (events.length === 0) return;

      for (const event of events) {
        this.searchHistory.append(event);
      }
      this.messageHistory = history;
    });
  }

  public async compact(): Promise<void> {
    return this.serializeMutation(async () => {
      const history = this.messageHistory;

      const start = seekSafeCut(history, this.compactGuardBeginning, +1);
      const end = seekSafeCut(history, history.length - this.compactGuardEnd, -1);

      if (end - start < this.compactMinMessages) return;

      const middle = history.slice(start, end);
      if (middle.length === 0) return;

      const stream = this.compactProvider.getMessageStream(COMPACT_PROMPT, middle, []);
      const result = await stream.completed;
      const assistantMessages = result.filter(
        (message): message is AssistantMessage => message.role === 'assistant'
          && message.content.some(
            (part) => part.type === 'text' && part.text.trim().length > 0,
          ),
      );

      if (assistantMessages.length === 0) return;

      const compactedMessage: CompactedMessage = Object.freeze({
        role: 'compacted',
        content: assistantMessages.flatMap((message) => message.content),
        createdAt: new Date(),
        messageId: nanoid(),
        compactedMessageIds: Object.freeze(middle.map((message) => message.messageId)),
      });
      const compactedHistory = applyCompaction(history, compactedMessage);

      this.searchHistory.append(compactedMessage);
      this.messageHistory = compactedHistory;
    });
  }

  private rebuildHistory(fullHistory: readonly Message[]): Message[] {
    let history: Message[] = [];
    for (const event of fullHistory) {
      if (event.role === 'folded') {
        history = applyFold(history, event);
      } else if (event.role === 'compacted') {
        history = applyCompaction(history, event);
      } else {
        history.push(event);
      }
    }
    return history;
  }
}

export {
  Context,
};
