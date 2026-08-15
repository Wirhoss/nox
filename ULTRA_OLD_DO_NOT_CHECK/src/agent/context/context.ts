import { nanoid } from 'nanoid';

import { createLogger } from '../../logger';

import { applyCompaction, seekSafeCut } from './compact';
import { MessageTooLargeError } from './errors';
import { applyFold, foldHistory } from './fold';
import { freezeMessage } from './immutable';
import { resolveContextOptions } from './options';
import { COMPACT_PROMPT } from './prompt';
import { HistorySearchToolSet } from './search';
import { TokenEstimator } from './tokens';
import { Transcript } from './transcript';

import type {
  AssistantMessage,
  ChatProvider,
  CompactedMessage,
  Message,
  UserMessage,
} from '../../provider';
import type { Tool, ToolSet } from '../../tool';
import type { ContextOptions } from './options';

const HANDOFF_REQUEST_PREFIX = 'compaction-request';

interface ContextLoadDiagnostics {
  duplicateMessageIds: readonly string[];
  oversizedMessageIds: readonly string[];
}

const logger = createLogger('agent:context');

function createHandoffRequest(): UserMessage {
  return freezeMessage<UserMessage>({
    content: [{ text: 'Produce the handoff now.', type: 'text' }],
    createdAt: new Date(),
    messageId: `${HANDOFF_REQUEST_PREFIX}-${nanoid()}`,
    role: 'user',
  });
}

function hasUsableText(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
    && message.content.some((part) => part.type === 'text' && part.text.trim().length > 0);
}

class Context {
  readonly #systemPrompt: string;
  readonly #tools: Readonly<Record<string, Tool>>;

  readonly #compactProvider: ChatProvider;
  readonly #compactGuardBeginning: number;
  readonly #compactGuardEnd: number;
  readonly #compactMinMessages: number;
  readonly #maxMessageTokens?: number;
  readonly #pressureTokenLimit?: number;

  readonly #estimator: TokenEstimator;
  readonly #transcript: Transcript;
  readonly #historyTools: HistorySearchToolSet;
  readonly #loadDiagnostics: ContextLoadDiagnostics;

  #activeHistory: Message[];

  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    systemPrompt: string,
    compactProvider: ChatProvider,
    contextOptions: ContextOptions = {},
  ) {
    const options = resolveContextOptions(contextOptions);

    this.#systemPrompt = systemPrompt;
    this.#compactProvider = compactProvider;
    this.#compactGuardBeginning = options.compactGuardBeginning;
    this.#compactGuardEnd = options.compactGuardEnd;
    this.#compactMinMessages = options.compactMinMessages;
    this.#maxMessageTokens = options.maxMessageTokens;
    this.#pressureTokenLimit = options.pressureTokenLimit;
    this.#tools = options.tools;

    this.#transcript = new Transcript(options.fullHistory);
    this.#historyTools = new HistorySearchToolSet(this.#transcript);

    this.#estimator = new TokenEstimator(
      systemPrompt,
      [...Object.values(this.#tools), ...Object.values(this.#historyTools.tools)],
      options.tokenCounter,
    );

    this.#activeHistory = this.#rebuildHistory(this.#transcript.messages);
    this.#loadDiagnostics = Object.freeze({
      duplicateMessageIds: this.#transcript.duplicateMessageIds,
      oversizedMessageIds: this.#findOversizedMessages(),
    });
  }

  public getFullHistory(): readonly Message[] {
    return this.#transcript.messages;
  }

  public getHistory(): readonly Message[] {
    return Object.freeze([...this.#activeHistory]);
  }

  public getSystemPrompt(): string {
    return this.#systemPrompt;
  }

  public getTools(): Readonly<Record<string, Tool>> {
    return this.#tools;
  }

  public getHistorySearchToolSet(): ToolSet {
    return this.#historyTools;
  }

  public getLoadDiagnostics(): ContextLoadDiagnostics {
    return this.#loadDiagnostics;
  }

  public getTokenEstimate(): number {
    return this.#estimator.estimateHistory(this.#activeHistory);
  }

  public isUnderPressure(): boolean {
    return this.#pressureTokenLimit !== undefined
      && this.getTokenEstimate() > this.#pressureTokenLimit;
  }

  /** @throws {MessageTooLargeError} if the message exceeds `maxMessageTokens`. */
  public addMessage(message: Message): void {
    this.#assertWithinIngressLimit(message);
    this.#activeHistory.push(this.#transcript.append(message));
  }

  public async fold(fromMessageId?: string, toMessageId?: string): Promise<void> {
    return this.#serializeMutation(() => {
      this.#applyFoldResult(foldHistory(this.#activeHistory, fromMessageId, toMessageId));
    });
  }

  public async compact(): Promise<void> {
    return this.#serializeMutation(async () => {
      if (this.#pressureTokenLimit !== undefined) {
        if (!this.isUnderPressure()) return;
        this.#reclaimByFolding();
        if (!this.isUnderPressure()) return;
      }

      const middle = this.#selectCompactionRange();
      if (middle === undefined) return;

      const compacted = await this.#summarize(middle);
      if (compacted === undefined) return;

      const history = applyCompaction(this.#activeHistory, compacted);
      this.#transcript.append(compacted);
      this.#activeHistory = history;
    });
  }

  #applyFoldResult({ events, history }: { events: readonly Message[]; history: Message[] }): void {
    if (events.length === 0) return;
    for (const event of events) this.#transcript.append(event);
    this.#activeHistory = history;
  }

  #assertWithinIngressLimit(message: Message): void {
    if (this.#maxMessageTokens === undefined) return;

    const estimate = this.#estimator.estimateMessage(message);
    if (estimate > this.#maxMessageTokens) {
      throw new MessageTooLargeError(message.messageId, estimate, this.#maxMessageTokens);
    }
  }

  #findOversizedMessages(): readonly string[] {
    const maxMessageTokens = this.#maxMessageTokens;
    if (maxMessageTokens === undefined) return Object.freeze([]);

    const oversized = this.#activeHistory
      .filter((message) => this.#estimator.estimateMessage(message) > maxMessageTokens)
      .map((message) => message.messageId);

    if (oversized.length > 0) {
      logger.warn(
        { maxMessageTokens, messageIds: oversized },
        'Loaded persisted messages that exceed the configured ingress cap.',
      );
    }
    return Object.freeze(oversized);
  }

  #reclaimByFolding(): void {
    const history = this.#activeHistory;
    const firstAssistant = history.findIndex((message) => message.role === 'assistant');
    if (firstAssistant === -1) return;

    const from = firstAssistant + 1;
    const to = history.length - 1 - this.#compactGuardEnd;
    if (to < from) return;

    this.#applyFoldResult(
      foldHistory(history, history[from]?.messageId, history[to]?.messageId),
    );
  }

  #rebuildHistory(fullHistory: readonly Message[]): Message[] {
    let history: Message[] = [];
    for (const event of fullHistory) {
      if (event.role === 'folded') history = applyFold(history, event);
      else if (event.role === 'compacted') history = applyCompaction(history, event);
      else history.push(event);
    }
    return history;
  }

  #selectCompactionRange(): readonly Message[] | undefined {
    const history = this.#activeHistory;
    const start = seekSafeCut(history, this.#compactGuardBeginning, +1);
    const end = seekSafeCut(history, history.length - this.#compactGuardEnd, -1);

    if (end - start < this.#compactMinMessages) return undefined;

    const middle = history.slice(start, end);
    return middle.length === 0 ? undefined : middle;
  }

  #serializeMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(mutation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #summarize(middle: readonly Message[]): Promise<CompactedMessage | undefined> {
    const stream = this.#compactProvider.getMessageStream(
      COMPACT_PROMPT,
      [...middle, createHandoffRequest()],
      [],
    );
    const summary = (await stream.completed).filter(hasUsableText);

    if (summary.length === 0) {
      logger.warn(
        { messageCount: middle.length },
        'Compaction provider returned no usable summary; keeping the range intact.',
      );
      return undefined;
    }

    return freezeMessage<CompactedMessage>({
      compactedMessageIds: middle.map((message) => message.messageId),
      content: summary.flatMap((message) => [...message.content]),
      createdAt: new Date(),
      messageId: nanoid(),
      role: 'compacted',
    });
  }
}

export {
  Context,
};

export type {
  ContextLoadDiagnostics,
};
