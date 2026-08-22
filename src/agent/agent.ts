import { Session } from './session';
import { composeSessionTools } from './tools';

import type { AuthorityCatalog } from '../auth/authority';
import type { AuthorizationProvider } from '../auth/authorization';
import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { GateEvaluator, GatePolicyInput } from '../tool/gate';
import type { ToolSetGrant } from '../tool/tool';
import type { ContextOptions } from './context/options';
import type { RunnerOptions } from './runner';

interface AgentOptions extends RunnerOptions {
  /**
   * Every authority this Nox knows. A tool naming one that is not in here is a
   * configuration error, caught when a session composes its tools rather than
   * when somebody eventually calls it.
   */
  authorities: AuthorityCatalog;
  /**
   * Who this agent is. Every session it opens is stored under it, so a
   * transcript stays attributable to the prompt and tools that produced it.
   */
  agentId: string;
  /** Provider and model used for compaction; each defaults to the agent's main one. */
  compactionModel?: ModelConfig;
  compactionProvider?: ChatProvider;
  /** Context policy, minus what a session supplies: history, sink and tools. */
  context?: Omit<
    ContextOptions,
    'compactionModel' | 'fullHistory' | 'logger' | 'onAppend' | 'tools'
  >;
  directToolSets?: readonly ToolSetGrant[];
  gate?: GatePolicyInput;
  gateEvaluators?: readonly GateEvaluator[];
  logger?: Logger;
  routedToolSets?: readonly ToolSetGrant[];
  systemPrompt: string;
}

interface OpenSessionOptions {
  /**
   * Where this conversation's authority comes from. It belongs to the surface
   * that opened the session — a broker knows its own issuer and its own people —
   * so the agent carries it through rather than inventing one.
   */
  authorization?: AuthorizationProvider;
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit for a new session; pass one to resume it, or to name a new one. */
  sessionId?: string;
  title?: string;
}

/**
 * A live agent: one provider, one model, one system prompt and a current tool-set
 * configuration. Every session resolves and snapshots its tools when opened, so
 * a later session may use newer sets without changing any session already alive.
 */
class Agent {
  readonly #agentId: string;
  readonly #authorities: AuthorityCatalog;
  readonly #compactionModel: ModelConfig;
  readonly #compactionProvider: ChatProvider;
  readonly #context?: Omit<
    ContextOptions,
    'compactionModel' | 'fullHistory' | 'logger' | 'onAppend' | 'tools'
  >;
  readonly #database: Database;
  readonly #directToolSets: readonly ToolSetGrant[];
  readonly #gate?: GatePolicyInput;
  readonly #gateEvaluators: readonly GateEvaluator[];
  readonly #logger?: Logger;
  readonly #maxIterations?: 'unlimited' | number;
  readonly #model: ModelConfig;
  readonly #provider: ChatProvider;
  readonly #routedToolSets: readonly ToolSetGrant[];
  readonly #systemPrompt: string;

  constructor(
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    options: AgentOptions,
  ) {
    this.#agentId = options.agentId;
    this.#authorities = options.authorities;
    this.#compactionModel = options.compactionModel ?? model;
    this.#compactionProvider = options.compactionProvider ?? provider;
    this.#database = database;
    this.#provider = provider;
    this.#model = model;
    this.#context = options.context;
    this.#directToolSets = options.directToolSets ?? [];
    this.#gate = options.gate;
    this.#gateEvaluators = Object.freeze([...(options.gateEvaluators ?? [])]);
    this.#logger = options.logger;
    this.#maxIterations = options.maxIterations;
    this.#routedToolSets = options.routedToolSets ?? [];
    this.#systemPrompt = options.systemPrompt;
  }

  public get agentId(): string {
    return this.#agentId;
  }

  public get model(): ModelConfig {
    return this.#model;
  }

  public get systemPrompt(): string {
    return this.#systemPrompt;
  }

  /** Resumes the session when `sessionId` names one, and starts one otherwise. */
  public openSession(options: OpenSessionOptions = {}): Promise<Session> {
    // Snapshot before Session.open reaches storage: changes after this call
    // belong to later sessions, even while this one is still loading.
    const tools = composeSessionTools(
      this.#directToolSets,
      this.#routedToolSets,
      this.#authorities,
    );

    return Session.open(this.#database, this.#provider, this.#model, {
      ...options,
      agentId: this.#agentId,
      authorities: this.#authorities,
      // The model's own window is the budget unless the agent overrode it.
      compactionProvider: this.#compactionProvider,
      context: {
        contextWindow: this.#model.contextWindow,
        ...this.#context,
        compactionModel: this.#compactionModel,
        tools,
      },
      gate: this.#gate,
      gateEvaluators: this.#gateEvaluators,
      logger: this.#logger,
      maxIterations: this.#maxIterations,
      systemPrompt: this.#systemPrompt,
    });
  }
}

export { Agent };

export type { AgentOptions, OpenSessionOptions };
