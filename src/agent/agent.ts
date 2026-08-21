import { ROUTER_TOOL_NAMES, ToolRouter } from '../tool/router';
import { Session } from './session';

import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { Tool, ToolSet } from '../tool/tool';
import type { ContextOptions } from './context/options';
import type { RunnerOptions } from './runner';

interface AgentOptions extends RunnerOptions {
  /** Context policy, minus what a session supplies: history, sink and tools. */
  context?: Omit<ContextOptions, 'fullHistory' | 'logger' | 'onAppend' | 'tools'>;
  directToolSets?: readonly ToolSet[];
  logger?: Logger;
  routedToolSets?: readonly ToolSet[];
  systemPrompt: string;
}

interface OpenSessionOptions {
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit for a new session; pass one to resume it, or to name a new one. */
  sessionId?: string;
  title?: string;
}

const ROUTER_TOOL_NAME_SET = new Set<string>(ROUTER_TOOL_NAMES);

function snapshotToolSets(
  toolSets: readonly ToolSet[],
  kind: 'direct' | 'routed',
): Readonly<Record<string, Tool>> {
  const tools = new Map<string, Tool>();

  for (const toolSet of [...toolSets]) {
    for (const [name, source] of Object.entries(toolSet.tools)) {
      if (source.name !== name) {
        throw new Error(`${kind} tool key ${name} does not match tool name ${source.name}.`);
      }
      if (ROUTER_TOOL_NAME_SET.has(name)) {
        throw new Error(`${kind} tool ${name} conflicts with a tool router tool.`);
      }
      if (tools.has(name)) {
        throw new Error(`${kind} tool ${name} is granted by more than one tool set.`);
      }
      tools.set(name, Object.freeze({ ...source }));
    }
  }

  return Object.freeze(Object.fromEntries([...tools].sort(([a], [b]) => a.localeCompare(b))));
}

function composeSessionTools(
  directSource: readonly ToolSet[],
  routedSource: readonly ToolSet[],
): Readonly<Record<string, Tool>> {
  const directTools = snapshotToolSets(directSource, 'direct');
  const routedTools = snapshotToolSets(routedSource, 'routed');

  for (const name of Object.keys(routedTools)) {
    if (directTools[name] !== undefined) {
      throw new Error(`Tool ${name} cannot be both direct and routed.`);
    }
  }

  const routed = Object.values(routedTools);
  if (routed.length === 0) return directTools;

  const router = new ToolRouter(routed);
  return Object.freeze({ ...directTools, ...router.tools });
}

/**
 * A live agent: one provider, one model, one system prompt and a current tool-set
 * configuration. Every session resolves and snapshots its tools when opened, so
 * a later session may use newer sets without changing any session already alive.
 */
class Agent {
  readonly #context?: Omit<ContextOptions, 'fullHistory' | 'logger' | 'onAppend' | 'tools'>;
  readonly #database: Database;
  readonly #directToolSets: readonly ToolSet[];
  readonly #logger?: Logger;
  readonly #maxIterations?: 'unlimited' | number;
  readonly #model: ModelConfig;
  readonly #provider: ChatProvider;
  readonly #routedToolSets: readonly ToolSet[];
  readonly #systemPrompt: string;

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
    this.#directToolSets = options.directToolSets ?? [];
    this.#logger = options.logger;
    this.#maxIterations = options.maxIterations;
    this.#routedToolSets = options.routedToolSets ?? [];
    this.#systemPrompt = options.systemPrompt;
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
    const tools = composeSessionTools(this.#directToolSets, this.#routedToolSets);

    return Session.open(this.#database, this.#provider, this.#model, {
      ...options,
      // The model's own window is the budget unless the agent overrode it.
      context: { contextWindow: this.#model.contextWindow, ...this.#context, tools },
      logger: this.#logger,
      maxIterations: this.#maxIterations,
      systemPrompt: this.#systemPrompt,
    });
  }
}

export { Agent };

export type { AgentOptions, OpenSessionOptions };
