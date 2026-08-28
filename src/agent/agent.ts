import {
  ATTACH_ARTIFACT_TOOL_NAME,
  attachArtifactTool,
  READ_ARTIFACT_TOOL_NAME,
  readArtifactTool,
} from './artifactTool';
import { Session } from './session';
import { composeSessionTools } from './tools';

import type { ArtifactPipeline } from '../artifact/pipeline';
import type { ArtifactScope } from '../artifact/types';
import type { AuthorityCatalog } from '../auth/authority';
import type { AuthorizationProvider } from '../auth/authorization';
import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { GateEvaluator, GatePolicyInput } from '../tool/gate';
import type { ContextOptions } from './context/options';
import type { RunnerOptions } from './runner';
import type { ChatProvider, Memory, ModelConfig, ToolSetGrant } from '@nox/extension-api';

interface AgentOptions extends RunnerOptions {
  /**
   * Every authority this Nox knows. A tool naming one that is not in here is a
   * configuration error, caught when a session composes its tools rather than
   * when somebody eventually calls it.
   */
  authorities: AuthorityCatalog;
  /** Durable storage used only when a session also receives an explicit output scope. */
  artifacts?: ArtifactPipeline;
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
  /** The single long-term memory selected by this agent's blueprint. */
  memory?: Memory;
  memoryMaxTokens?: number;
  routedToolSets?: readonly ToolSetGrant[];
  systemPrompt: string;
  /**
   * The zone this installation reads clocks in. It reaches the model as the
   * timestamp on every message it is shown, which is how an agent knows what day
   * it is at all — a model with no clock in its context answers from whenever it
   * was trained.
   */
  timeZone?: string;
  /** Provider and model used to name sessions; each defaults to the agent's main one. */
  titleModel?: ModelConfig;
  titleProvider?: ChatProvider;
}

interface OpenSessionOptions {
  /** Ownership assigned to files generated in this concrete conversation. */
  artifactScope?: ArtifactScope;
  /**
   * Where this conversation's authority comes from. It belongs to the surface
   * that opened the session — a broker knows its own issuer and its own people —
   * so the agent carries it through rather than inventing one.
   */
  authorization?: AuthorizationProvider;
  metadata?: Readonly<Record<string, unknown>>;
  /** Optional conversation-local model from this agent's configured provider. */
  modelId?: string;
  /** Omit for a new session; pass one to resume it, or to name a new one. */
  sessionId?: string;
  title?: string;
}

/** Adds the small capability map that makes the routed catalog discoverable. */
function withRoutedToolSetCatalog(systemPrompt: string, grants: readonly ToolSetGrant[]): string {
  const summaries = new Set<string>();

  for (const grant of grants) {
    const allowed = grant.tools === undefined ? undefined : new Set(grant.tools);
    const contributesTool = Object.keys(grant.toolSet.tools).some(
      (name) => allowed === undefined || allowed.has(name),
    );
    if (!contributesTool) continue;

    const name = grant.toolSet.name.replace(/\s+/gu, ' ').trim();
    const description = grant.toolSet.description.replace(/\s+/gu, ' ').trim();
    summaries.add(`- ${name}: ${description}`);
  }

  if (summaries.size === 0) return systemPrompt;

  const catalog = [
    'Routed tool sets available through search_tool:',
    ...[...summaries].sort((a, b) => a.localeCompare(b)),
    '',
    'Use these descriptions to decide when to call search_tool and which capability keywords to ' +
      'search. Its results are authoritative for exact tool names and parameter schemas.',
  ].join('\n');
  return `${systemPrompt}\n\n${catalog}`;
}

/**
 * A live agent: one provider, one model, one system prompt and a current tool-set
 * configuration. Every session resolves and snapshots its tools when opened, so
 * a later session may use newer sets without changing any session already alive.
 */
class Agent {
  readonly #agentId: string;
  readonly #artifacts?: ArtifactPipeline;
  readonly #authorities: AuthorityCatalog;
  readonly #compactionModel?: ModelConfig;
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
  readonly #memory?: Memory;
  readonly #memoryMaxTokens?: number;
  readonly #model: ModelConfig;
  readonly #provider: ChatProvider;
  readonly #routedToolSets: readonly ToolSetGrant[];
  readonly #systemPrompt: string;
  readonly #timeZone?: string;
  readonly #titleModel?: ModelConfig;
  readonly #titleProvider: ChatProvider;

  constructor(
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    options: AgentOptions,
  ) {
    this.#agentId = options.agentId;
    this.#artifacts = options.artifacts;
    this.#authorities = options.authorities;
    this.#compactionModel = options.compactionModel;
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
    this.#memory = options.memory;
    this.#memoryMaxTokens =
      options.memory === undefined ? undefined : (options.memoryMaxTokens ?? 2048);
    this.#routedToolSets = options.routedToolSets ?? [];
    this.#systemPrompt = options.systemPrompt;
    this.#timeZone = options.timeZone;
    this.#titleModel = options.titleModel;
    this.#titleProvider = options.titleProvider ?? provider;
  }

  public get agentId(): string {
    return this.#agentId;
  }

  public get model(): ModelConfig {
    return this.#model;
  }

  public get modelIds(): readonly string[] {
    return Object.freeze(
      [
        ...new Set([
          this.#model.modelId,
          ...this.#provider.listModelConfigs().map((model) => model.modelId),
        ]),
      ].sort((a, b) => a.localeCompare(b)),
    );
  }

  public get systemPrompt(): string {
    return this.#systemPrompt;
  }

  /** Resumes the session when `sessionId` names one, and starts one otherwise. */
  public openSession(options: OpenSessionOptions = {}): Promise<Session> {
    const model =
      options.modelId === undefined || options.modelId === this.#model.modelId
        ? this.#model
        : this.#provider.getModelConfig(options.modelId);
    if (model === undefined) {
      throw new Error(
        `Model "${options.modelId ?? ''}" is not available to agent "${this.#agentId}".`,
      );
    }

    // Snapshot before Session.open reaches storage: changes after this call
    // belong to later sessions, even while this one is still loading.
    const configuredTools = composeSessionTools(
      this.#directToolSets,
      this.#routedToolSets,
      this.#authorities,
    );
    const outputEnabled = this.#artifacts !== undefined && options.artifactScope !== undefined;
    let tools = configuredTools;
    if (outputEnabled) {
      const attachmentTool = attachArtifactTool();
      const readerTool = readArtifactTool();
      for (const tool of [attachmentTool, readerTool]) {
        if (configuredTools[tool.name] !== undefined) {
          throw new Error(`Configured tool ${tool.name} conflicts with Nox's core artifact tools.`);
        }
      }
      tools = Object.freeze({
        ...configuredTools,
        [ATTACH_ARTIFACT_TOOL_NAME]: attachmentTool,
        [READ_ARTIFACT_TOOL_NAME]: readerTool,
      });
    }
    const systemPrompt = withRoutedToolSetCatalog(this.#systemPrompt, this.#routedToolSets);

    return Session.open(this.#database, this.#provider, model, {
      ...options,
      agentId: this.#agentId,
      ...(this.#artifacts === undefined ? {} : { artifacts: this.#artifacts }),
      authorities: this.#authorities,
      // The selected model's own window is the budget unless the agent overrode it.
      compactionProvider: this.#compactionProvider,
      context: {
        contextWindow: model.contextWindow,
        ...this.#context,
        compactionModel: this.#compactionModel ?? model,
        ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }),
        ...(this.#memoryMaxTokens === undefined
          ? {}
          : { memoryReserveTokens: this.#memoryMaxTokens + 256 }),
        tools,
      },
      gate: this.#gate,
      gateEvaluators: this.#gateEvaluators,
      logger: this.#logger,
      maxIterations: this.#maxIterations,
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      ...(this.#memoryMaxTokens === undefined ? {} : { memoryMaxTokens: this.#memoryMaxTokens }),
      systemPrompt,
      ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }),
      titleModel: this.#titleModel ?? model,
      titleProvider: this.#titleProvider,
    });
  }
}

export { Agent };

export type { AgentOptions, OpenSessionOptions };
