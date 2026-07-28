import { nanoid } from 'nanoid';

import { formatHistoryMessage } from './format';
import { applyCompaction, applyFold, foldHistory, seekSafeCut } from './history';
import { COMPACT_PROMPT } from './prompt';
import { MessageSearchIndex } from './searchIndex';
import { SessionHistoryToolSet } from './tools';

import type {
  AssistantMessage,
  ChatProvider,
  CompactionMessage,
  Message,
} from '../../provider';
import type { Tool } from '../../tool';
import type { FoldRange } from './history';
import type { ContextOptions } from './types';

class Context {
  private readonly systemPrompt: string;
  private readonly tools: Record<string, Tool>;

  private readonly compactProvider: ChatProvider;
  private readonly compactGuardBeginning: number;
  private readonly compactGuardEnd: number;
  private readonly compactMinMessages: number;

  private sessionHistoryToolSet: SessionHistoryToolSet;
  private searchIndex: MessageSearchIndex;

  private messageHistory: Message[];

  constructor(systemPrompt: string, compactProvider: ChatProvider, contextOptions: ContextOptions) {
    this.systemPrompt = systemPrompt;
    this.compactProvider = compactProvider;
    this.tools = contextOptions.tools ?? {};
    this.compactGuardBeginning = contextOptions.compactGuardBeginning ?? 5;
    this.compactGuardEnd = contextOptions.compactGuardEnd ?? 5;
    this.compactMinMessages = contextOptions.compactMinMessages ?? 10;
    this.searchIndex = new MessageSearchIndex(contextOptions.fullHistory ?? []);
    this.sessionHistoryToolSet = new SessionHistoryToolSet(
      (query, options) => this.searchIndex.search(query, this.messageHistory, options),
      (message) => formatHistoryMessage(message),
    );
    this.messageHistory = this.rebuildHistory(contextOptions.fullHistory ?? []);
  }

  public getFullHistory(): readonly Message[] {
    return this.searchIndex.history;
  }

  public getHistory(): readonly Message[] {
    return this.messageHistory;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public getTools(): Record<string, Tool> {
    return this.tools;
  }

  public getSessionHistoryToolSet(): SessionHistoryToolSet {
    return this.sessionHistoryToolSet;
  }

  public addMessage(message: Message): void {
    const frozen = Object.freeze(message);
    this.searchIndex.append(frozen);
    this.messageHistory.push(frozen);
  }

  // `range` scopes the fold to the turn the runner just finished. Folding the
  // whole history instead removes tool traffic from the earliest turn in the
  // session, which invalidates the provider's cached prefix all the way back
  // to it.
  public fold(range?: FoldRange): void {
    const { events, history } = foldHistory(this.messageHistory, range);
    if (events.length === 0) return;

    for (const event of events) {
      this.searchIndex.append(event);
    }
    this.messageHistory = history;
  }

  public async compact(): Promise<void> {
    const history = this.messageHistory;

    const lastCompactionIndex = Math.max(0, history.findLastIndex((message) => message.role === 'compaction'));
    const start = seekSafeCut(history, lastCompactionIndex + this.compactGuardBeginning, +1);
    const end = seekSafeCut(history, history.length - this.compactGuardEnd, -1);

    if (end - start < this.compactMinMessages) return;

    const middle = history.slice(start, end);
    if (middle.length === 0) return;

    const stream = this.compactProvider.getMessageStream(COMPACT_PROMPT, middle, []);
    const result = await stream.completed;
    const assistantMessages = result.filter(
      (message): message is AssistantMessage => message.role === 'assistant',
    );

    if (assistantMessages.length === 0) return;

    const compactionMessage: CompactionMessage = Object.freeze({
      role: 'compaction',
      content: assistantMessages.flatMap((message) => message.content),
      createdAt: new Date(),
      messageId: nanoid(),
      replacedMessageIds: Object.freeze(middle.map((message) => message.messageId)),
    });
    const compactedHistory = applyCompaction(history, compactionMessage);

    this.searchIndex.append(compactionMessage);
    this.messageHistory = compactedHistory;
  }

  // The transcript already records every view transform that was applied, so a
  // rebuild is a single ordered replay. Reproducing the exact array that was
  // last sent is what lets a reloaded session hit the provider's prompt cache.
  private rebuildHistory(fullHistory: readonly Message[]): Message[] {
    let history: Message[] = [];

    for (const event of fullHistory) {
      if (event.role === 'fold') {
        history = applyFold(history, event);
      } else if (event.role === 'compaction') {
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
