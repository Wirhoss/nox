import { nanoid } from 'nanoid';

import { Mutex } from '../../utils/mutex';
import { applyCompaction, seekSafeCut } from './compact';
import { applyFold, foldHistory, type FoldOptions } from './fold';
import { freezeMessage } from './immutable';
import { type ContextOptions, resolveContextOptions } from './options';
import { COMPACT_PROMPT } from './prompt';
import { HistorySearchToolSet } from './search';
import { TokenEstimator } from './tokens';
import { Transcript } from './transcript';

import type { Logger } from '../../logger/logger';
import type { ChatProvider } from '../../provider/provider';
import type { Tool } from '../../tool/tool';
import type { AssistantMessage, CompactedMessage, Message, UserMessage } from './message';

const HANDOFF_REQUEST_PREFIX = 'compaction-request';

interface CompactResult {
  readonly compacted: boolean;
  readonly folded: boolean;
}

function createHandoffRequest(): UserMessage {
  return freezeMessage<UserMessage>({
    content: [{ text: 'Produce the handoff now.', type: 'text' }],
    createdAt: new Date(),
    messageId: `${HANDOFF_REQUEST_PREFIX}-${nanoid()}`,
    role: 'user',
  });
}

function hasUsableText(message: Message): message is AssistantMessage {
  return (
    message.role === 'assistant' &&
    message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
  );
}

class Context {
  readonly #systemPrompt: string;
  readonly #tools: Readonly<Record<string, Tool>>;

  readonly #compactGuardBeginningTokens: number;
  readonly #compactGuardEndTokens: number;
  readonly #compactMinTokens: number;
  readonly #compactProvider: ChatProvider;
  readonly #foldMinReductionRatio: number;
  readonly #pressureTokenLimit?: number;

  readonly #estimator: TokenEstimator;
  readonly #historyTools: HistorySearchToolSet;
  readonly #logger?: Logger;
  readonly #transcript: Transcript;

  readonly #mutations = new Mutex();

  #activeHistory: Message[];

  constructor(
    systemPrompt: string,
    compactProvider: ChatProvider,
    contextOptions: ContextOptions = {},
  ) {
    const options = resolveContextOptions(contextOptions);

    this.#systemPrompt = systemPrompt;
    this.#compactProvider = compactProvider;
    this.#compactGuardBeginningTokens = options.compactGuardBeginningTokens;
    this.#compactGuardEndTokens = options.compactGuardEndTokens;
    this.#compactMinTokens = options.compactMinTokens;
    this.#foldMinReductionRatio = options.foldMinReductionRatio;
    this.#logger = options.logger;
    this.#pressureTokenLimit = options.pressureTokenLimit;

    this.#transcript = new Transcript(options.fullHistory, {
      logger: options.logger,
      onAppend: options.onAppend,
    });
    this.#historyTools = new HistorySearchToolSet(this.#transcript);

    const duplicateToolName = Object.keys(this.#historyTools.tools).find(
      (name) => options.tools[name] !== undefined,
    );
    if (duplicateToolName !== undefined) {
      throw new Error(`Tool ${duplicateToolName} conflicts with a context history tool.`);
    }
    this.#tools = Object.freeze(
      Object.fromEntries(
        [...Object.entries(options.tools), ...Object.entries(this.#historyTools.tools)].sort(
          ([a], [b]) => a.localeCompare(b),
        ),
      ),
    );

    this.#estimator = new TokenEstimator(
      systemPrompt,
      Object.values(this.#tools),
      options.tokenCounter,
    );

    this.#activeHistory = this.#rebuildHistory(this.#transcript.messages);
  }

  public addMessage(message: Message): void {
    this.#activeHistory.push(this.#transcript.append(message));
  }

  public async compact(): Promise<CompactResult> {
    return this.#mutations.run(async () => {
      let folded = false;
      if (this.#pressureTokenLimit !== undefined) {
        if (!this.isUnderPressure()) return Object.freeze({ compacted: false, folded });
        folded = this.#reclaimByFolding();
        if (!this.isUnderPressure()) return Object.freeze({ compacted: false, folded });
      }

      const middle = this.#selectCompactionRange();
      if (middle === undefined) return Object.freeze({ compacted: false, folded });

      const compacted = await this.#summarize(middle);
      if (compacted === undefined) return Object.freeze({ compacted: false, folded });

      const replacedTokens = this.#estimateMessages(middle);
      const compactedTokens = this.#estimator.estimateMessage(compacted);
      if (compactedTokens >= replacedTokens) {
        this.#logger?.warn(
          { compactedTokens, messageCount: middle.length, replacedTokens },
          'Compaction did not reduce the context; keeping the range intact.',
        );
        return Object.freeze({ compacted: false, folded });
      }

      const history = applyCompaction(this.#activeHistory, compacted);
      this.#transcript.append(compacted);
      this.#rewriteHistory(history);
      return Object.freeze({ compacted: true, folded });
    });
  }

  public async fold(fromMessageId?: string, toMessageId?: string): Promise<boolean> {
    return this.#mutations.run(() =>
      this.#applyFoldResult(
        foldHistory(this.#activeHistory, this.#foldOptions(fromMessageId, toMessageId)),
      ),
    );
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

  public getTokenEstimate(): number {
    return this.#estimator.estimateHistory(this.#activeHistory);
  }

  public getTools(): Readonly<Record<string, Tool>> {
    return this.#tools;
  }

  public isUnderPressure(): boolean {
    return (
      this.#pressureTokenLimit !== undefined && this.getTokenEstimate() > this.#pressureTokenLimit
    );
  }

  #applyFoldResult({
    events,
    history,
  }: {
    events: readonly Message[];
    history: Message[];
  }): boolean {
    if (events.length === 0) return false;
    for (const event of events) this.#transcript.append(event);
    this.#rewriteHistory(history);
    return true;
  }

  #rewriteHistory(history: Message[]): void {
    this.#activeHistory = history;
  }

  #reclaimByFolding(): boolean {
    const history = this.#activeHistory;
    const firstAssistant = history.findIndex((message) => message.role === 'assistant');
    if (firstAssistant === -1) return false;

    const from = firstAssistant + 1;
    const to = this.#guardedEnd(history) - 1;
    if (to < from) return false;

    return this.#applyFoldResult(
      foldHistory(history, this.#foldOptions(history[from]?.messageId, history[to]?.messageId)),
    );
  }

  /** Folding is measured with the same estimator that decides pressure. */
  #foldOptions(fromMessageId?: string, toMessageId?: string): FoldOptions {
    return {
      estimateTokens: (message) => this.#estimator.estimateMessage(message),
      fromMessageId,
      minReductionRatio: this.#foldMinReductionRatio,
      toMessageId,
    };
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

  #estimateMessages(messages: readonly Message[]): number {
    return messages.reduce((total, message) => total + this.#estimator.estimateMessage(message), 0);
  }

  #guardedEnd(history: readonly Message[]): number {
    let end = history.length;
    let guardedTokens = 0;
    while (end > 0) {
      const message = history[end - 1];
      if (message === undefined) break;
      const nextTokens = this.#estimator.estimateMessage(message);
      if (guardedTokens + nextTokens > this.#compactGuardEndTokens) break;
      guardedTokens += nextTokens;
      end--;
    }
    return seekSafeCut(history, end, -1);
  }

  #guardedStart(history: readonly Message[]): number {
    let start = 0;
    let guardedTokens = 0;
    while (start < history.length) {
      const message = history[start];
      if (message === undefined) break;
      const nextTokens = this.#estimator.estimateMessage(message);
      if (guardedTokens + nextTokens > this.#compactGuardBeginningTokens) break;
      guardedTokens += nextTokens;
      start++;
    }
    return seekSafeCut(history, start, 1);
  }

  #selectCompactionRange(): readonly Message[] | undefined {
    const history = this.#activeHistory;
    const start = this.#guardedStart(history);
    const end = this.#guardedEnd(history);
    if (end <= start) return undefined;

    const middle = history.slice(start, end);
    return this.#estimateMessages(middle) >= this.#compactMinTokens ? middle : undefined;
  }

  async #summarize(middle: readonly Message[]): Promise<CompactedMessage | undefined> {
    const stream = this.#compactProvider.getMessageStream(
      COMPACT_PROMPT,
      [...middle, createHandoffRequest()],
      [],
    );
    const summary = (await stream.completed).filter(hasUsableText);

    if (summary.length === 0) {
      this.#logger?.warn(
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

export { Context };

export type { CompactResult };
