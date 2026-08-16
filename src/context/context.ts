import { nanoid } from "nanoid";

import { applyCompaction, seekSafeCut } from "./compact";
import { applyFold, foldHistory, type FoldOptions } from "./fold";
import { freezeMessage } from "./immutable";
import { type ContextOptions, resolveContextOptions } from "./options";
import { COMPACT_PROMPT } from "./prompt";
import { HistorySearchToolSet } from "./search";
import { TokenEstimator } from "./tokens";
import { Transcript } from "./transcript";

import type { Logger } from "../logger/logger";
import type { ChatProvider } from "../provider/provider";
import type { Tool, ToolSet } from "../tool/tool";
import type { AssistantMessage, CompactedMessage, Message, UserMessage } from "./message";

const HANDOFF_REQUEST_PREFIX = "compaction-request";

function createHandoffRequest(): UserMessage {
  return freezeMessage<UserMessage>({
    content: [{ text: "Produce the handoff now.", type: "text" }],
    createdAt: new Date(),
    messageId: `${HANDOFF_REQUEST_PREFIX}-${nanoid()}`,
    role: "user",
  });
}

function hasUsableText(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    message.content.some((part) => part.type === "text" && part.text.trim().length > 0)
  );
}

class Context {
  readonly #systemPrompt: string;
  readonly #tools: Readonly<Record<string, Tool>>;

  readonly #compactGuardBeginning: number;
  readonly #compactGuardEnd: number;
  readonly #compactMinMessages: number;
  readonly #compactProvider: ChatProvider;
  readonly #foldMinReductionRatio: number;
  readonly #pressureTokenLimit?: number;

  readonly #estimator: TokenEstimator;
  readonly #historyTools: HistorySearchToolSet;
  readonly #logger?: Logger;
  readonly #transcript: Transcript;

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
    this.#foldMinReductionRatio = options.foldMinReductionRatio;
    this.#logger = options.logger;
    this.#pressureTokenLimit = options.pressureTokenLimit;
    this.#tools = options.tools;

    this.#transcript = new Transcript(options.fullHistory, { logger: options.logger });
    this.#historyTools = new HistorySearchToolSet(this.#transcript);

    this.#estimator = new TokenEstimator(
      systemPrompt,
      [...Object.values(this.#tools), ...Object.values(this.#historyTools.tools)],
      options.tokenCounter,
    );

    this.#activeHistory = this.#rebuildHistory(this.#transcript.messages);
  }

  public addMessage(message: Message): void {
    this.#activeHistory.push(this.#transcript.append(message));
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
      this.#rewriteHistory(history);
    });
  }

  public async fold(fromMessageId?: string, toMessageId?: string): Promise<void> {
    return this.#serializeMutation(() => {
      this.#applyFoldResult(
        foldHistory(this.#activeHistory, this.#foldOptions(fromMessageId, toMessageId)),
      );
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

  public getTokenEstimate(): number {
    return this.#estimator.estimateHistory(this.#activeHistory);
  }

  public getTools(): Readonly<Record<string, Tool>> {
    return {...this.#tools, ...this.#historyTools.tools};
  }

  public isUnderPressure(): boolean {
    return (
      this.#pressureTokenLimit !== undefined && this.getTokenEstimate() > this.#pressureTokenLimit
    );
  }

  #applyFoldResult({ events, history }: { events: readonly Message[]; history: Message[] }): void {
    if (events.length === 0) return;
    for (const event of events) this.#transcript.append(event);
    this.#rewriteHistory(history);
  }

  #rewriteHistory(history: Message[]): void {
    this.#activeHistory = history;
  }

  #reclaimByFolding(): void {
    const history = this.#activeHistory;
    const firstAssistant = history.findIndex((message) => message.role === "assistant");
    if (firstAssistant === -1) return;

    const from = firstAssistant + 1;
    const to = history.length - 1 - this.#compactGuardEnd;
    if (to < from) return;

    this.#applyFoldResult(
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
      if (event.role === "folded") history = applyFold(history, event);
      else if (event.role === "compacted") history = applyCompaction(history, event);
      else history.push(event);
    }
    return history;
  }

  #selectCompactionRange(): readonly Message[] | undefined {
    const history = this.#activeHistory;
    const start = seekSafeCut(history, this.#compactGuardBeginning, 1);
    const end = seekSafeCut(history, history.length - this.#compactGuardEnd, -1);

    if (end - start < this.#compactMinMessages) return undefined;

    const middle = history.slice(start, end);
    return middle.length === 0 ? undefined : middle;
  }

  #serializeMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
    const result = this.#mutationQueue.then(mutation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
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
      this.#logger?.warn(
        { messageCount: middle.length },
        "Compaction provider returned no usable summary; keeping the range intact.",
      );
      return undefined;
    }

    return freezeMessage<CompactedMessage>({
      compactedMessageIds: middle.map((message) => message.messageId),
      content: summary.flatMap((message) => [...message.content]),
      createdAt: new Date(),
      messageId: nanoid(),
      role: "compacted",
    });
  }
}

export { Context };
