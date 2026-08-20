import { nanoid } from 'nanoid';

import { SessionStore } from '../database/sessionStore';
import { EventLog } from '../utils/eventLog';
import { Context } from './context/context';
import { Runner, type RunnerOptions, type RunnerState } from './runner';

import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { Message, UserMessage } from './context/message';
import type { ContextOptions } from './context/options';
import type { AgentEvent } from './events';

interface SessionOptions extends RunnerOptions {
  /** Everything the context needs except the history, which comes from storage. */
  context?: Omit<ContextOptions, 'fullHistory' | 'onAppend'>;
  logger?: Logger;
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit to start a new session; pass one to resume it. */
  sessionId?: string;
  systemPrompt: string;
  title?: string;
}

function toUserMessage(text: string): UserMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    messageId: nanoid(),
    role: 'user',
  };
}

/**
 * One agent's conversation: a transcript, the context derived from it, and the
 * runner that drives them.
 *
 * The session owns the one path out of the transcript. Every append — replies,
 * tool traffic, and the folds and compactions the context writes on its own —
 * reaches storage and the event log through the same sink, so neither can miss
 * a message by forgetting to subscribe somewhere.
 */
class Session {
  readonly #context: Context;
  readonly #events = new EventLog<AgentEvent>();
  readonly #runner: Runner;
  readonly #sessionId: string;
  readonly #store: SessionStore;

  private constructor(
    sessionId: string,
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    history: readonly Message[],
    options: SessionOptions,
  ) {
    this.#sessionId = sessionId;
    this.#store = new SessionStore(database, {
      logger: options.logger,
      onError: (error) => {
        // Durability is gone, the conversation is not. Whoever is watching gets
        // to decide whether that is worth acting on.
        this.#emit({ error, type: 'error' });
      },
    });

    this.#context = new Context(options.systemPrompt, provider, {
      ...options.context,
      fullHistory: history,
      logger: options.logger,
      onAppend: (message) => {
        this.#persist(message);
      },
    });

    this.#runner = new Runner(this.#context, this.#events, provider, model, {
      logger: options.logger,
      maxIterations: options.maxIterations,
    });
  }

  /** Resumes the session when `sessionId` is given, and starts one otherwise. */
  public static async open(
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    options: SessionOptions,
  ): Promise<Session> {
    const sessionId = options.sessionId ?? nanoid();
    const store = new SessionStore(database, { logger: options.logger });
    const stored = options.sessionId === undefined ? undefined : await store.load(sessionId);

    if (stored === undefined) {
      await store.create(sessionId, { metadata: options.metadata, title: options.title });
    }

    return new Session(sessionId, database, provider, model, stored?.messages ?? [], options);
  }

  /** Everything an observer can see, from the first event of the session. */
  public get events(): AsyncGenerator<AgentEvent> {
    return this.#events.subscribe();
  }

  /** Resolves once everything this session has written has reached storage. */
  public get flushed(): Promise<void> {
    return this.#store.flushed;
  }

  /** Resolves when the current run finishes; already resolved while idle. */
  public get idle(): Promise<void> {
    return this.#runner.idle;
  }

  public get sessionId(): string {
    return this.#sessionId;
  }

  public get state(): RunnerState {
    return this.#runner.state;
  }

  public abort(): Promise<boolean> {
    return this.#runner.abort();
  }

  /** The bounded working set actually sent to the model. */
  public getHistory(): readonly Message[] {
    return this.#context.getHistory();
  }

  /** The complete transcript, including everything folding and compaction replaced. */
  public getTranscript(): readonly Message[] {
    return this.#context.getFullHistory();
  }

  public send(text: string): void {
    this.#runner.send(toUserMessage(text));
  }

  public steer(text: string): Promise<void> {
    return this.#runner.steer(toUserMessage(text));
  }

  /** Ends the session and waits for what it wrote to reach storage. */
  public async stop(): Promise<void> {
    await this.#runner.stop();
    await this.#store.flushed;
  }

  /**
   * A deferred result can land after `stop()` closed the log. The message still
   * belongs to the transcript; there is simply nobody left to tell.
   */
  #emit(event: AgentEvent): void {
    if (!this.#events.isClosed) this.#events.push(event);
  }

  #persist(message: Message): void {
    this.#store.append(this.#sessionId, message);
    this.#emit({ message, type: 'message' });
  }
}

export { Session };

export type { SessionOptions };
