import { Session } from './session';

import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { Tool } from '../tool/tool';
import type { ContextOptions } from './context/options';
import type { RunnerOptions } from './runner';

interface AgentOptions extends RunnerOptions {
  /** Context policy, minus what a session supplies: history, sink and tools. */
  context?: Omit<ContextOptions, 'fullHistory' | 'logger' | 'onAppend' | 'tools'>;
  logger?: Logger;
  systemPrompt: string;
  tools?: Readonly<Record<string, Tool>>;
}

interface OpenSessionOptions {
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit for a new session; pass one to resume it, or to name a new one. */
  sessionId?: string;
  title?: string;
}

/**
 * A live agent: one provider, one model, one system prompt and one set of tools.
 *
 * Its sessions are conversations with the same agent, not with configurations
 * that happen to be similar — the prompt and the tool schemas are the agent's,
 * so the cached prefix is identical across every session it opens. What varies
 * per session is only what a conversation owns: its identity and its history.
 */
class Agent {
  readonly #context?: Omit<ContextOptions, 'fullHistory' | 'logger' | 'onAppend' | 'tools'>;
  readonly #database: Database;
  readonly #logger?: Logger;
  readonly #maxIterations?: 'unlimited' | number;
  readonly #model: ModelConfig;
  readonly #provider: ChatProvider;
  readonly #systemPrompt: string;
  readonly #tools: Readonly<Record<string, Tool>>;

  constructor(
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    options: AgentOptions,
  ) {
    this.#database = database;
    this.#provider = provider;
    this.#model = model;
    this.#context = options.context;
    this.#logger = options.logger;
    this.#maxIterations = options.maxIterations;
    this.#systemPrompt = options.systemPrompt;
    this.#tools = options.tools ?? {};
  }

  public get model(): ModelConfig {
    return this.#model;
  }

  public get systemPrompt(): string {
    return this.#systemPrompt;
  }

  public get tools(): Readonly<Record<string, Tool>> {
    return this.#tools;
  }

  /** Resumes the session when `sessionId` names one, and starts one otherwise. */
  public openSession(options: OpenSessionOptions = {}): Promise<Session> {
    return Session.open(this.#database, this.#provider, this.#model, {
      ...options,
      context: { ...this.#context, tools: this.#tools },
      logger: this.#logger,
      maxIterations: this.#maxIterations,
      systemPrompt: this.#systemPrompt,
    });
  }
}

export { Agent };

export type { AgentOptions, OpenSessionOptions };
