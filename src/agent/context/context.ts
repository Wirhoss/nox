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
  #providerTokenOffset?: number;

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
      // Compaction is budget-triggered by definition. Without a configured
      // context window there is no budget, and summarizing on a guess is worse
      // than not summarizing: the working set is not known to be in trouble,
      // the reduction is lossy, and nobody asked for it.
      if (this.#pressureTokenLimit === undefined || !this.isUnderPressure()) {
        return Object.freeze({ compacted: false });
      }

      // Fold first — Law 2 — but only over traffic the model has already
      // consumed. A tool loop still in flight is off limits until it settles,
      // so a long loop under pressure collapses its finished predecessors and
      // leaves its own pairs alone. Without this, pressure inside one long loop
      // reaches the lossy path while the lossless one is still waiting.
      const settled = this.#settledBoundaryId();
      if (settled !== undefined) {
        this.#applyFoldResult(
          foldHistory(this.#activeHistory, this.#foldOptions(undefined, settled)),
        );
        if (!this.isUnderPressure()) return Object.freeze({ compacted: false });
      }

      const middle = this.#selectCompactionRange();
      if (middle === undefined) return Object.freeze({ compacted: false });

      const compacted = await this.#summarize(middle);
      if (compacted === undefined) return Object.freeze({ compacted: false });

      const replacedTokens = this.#estimateMessages(middle);
      const compactedTokens = this.#estimator.estimateMessage(compacted);
      if (compactedTokens >= replacedTokens) {
        this.#logger?.warn(
          { compactedTokens, messageCount: middle.length, replacedTokens },
          'Compaction did not reduce the context; keeping the range intact.',
        );
        return Object.freeze({ compacted: false });
      }

      const history = applyCompaction(this.#activeHistory, compacted);
      this.#transcript.append(compacted);
      this.#rewriteHistory(history);
      return Object.freeze({ compacted: true });
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

  /**
   * Anchors local accounting to the provider's count for the exact request that
   * produced the usage. Later appends and reductions remain an estimated delta
   * until another provider count refreshes the anchor.
   */
  public recordInputUsage(inputTokens: number, requestTokenEstimate: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens < 0) {
      throw new RangeError('inputTokens must be a finite, non-negative number.');
    }
    if (!Number.isFinite(requestTokenEstimate) || requestTokenEstimate < 0) {
      throw new RangeError('requestTokenEstimate must be a finite, non-negative number.');
    }
    this.#providerTokenOffset = inputTokens - requestTokenEstimate;
  }

  public getTools(): Readonly<Record<string, Tool>> {
    return this.#tools;
  }

  public isUnderPressure(): boolean {
    if (this.#pressureTokenLimit === undefined) return false;

    const estimate = this.getTokenEstimate();
    const accountedTokens = Math.max(0, estimate + (this.#providerTokenOffset ?? 0));
    return accountedTokens > this.#pressureTokenLimit;
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
    // The provider's count described the history this just replaced. Carrying
    // an absolute correction from one scale onto a much smaller one would keep
    // reporting pressure that is no longer there; the next request re-anchors.
    this.#providerTokenOffset = undefined;
  }

  /**
   * The last message the model has demonstrably consumed. Everything after it
   * belongs to a tool loop still in flight, which nothing may collapse yet.
   */
  #settledBoundaryId(): string | undefined {
    const history = this.#activeHistory;
    const lastAssistant = history.findLastIndex((message) => message.role === 'assistant');
    if (lastAssistant === -1) return undefined;

    const inFlight = history
      .slice(lastAssistant + 1)
      .some((message) => message.role === 'toolCall' || message.role === 'toolResponse');

    return history[inFlight ? lastAssistant : history.length - 1]?.messageId;
  }

  /** Folding is measured with the same estimator used for unobserved token deltas. */
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
