import { ROUTER_TOOL_NAMES, ToolRouter } from '../tool/router';
import { Session } from './session';

import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { GateEvaluator, GatePolicyInput } from '../tool/gate';
import type { Tool, ToolExecution, ToolRisk, ToolSetGrant } from '../tool/tool';
import type { ContextOptions } from './context/options';
import type { RunnerOptions } from './runner';

interface AgentOptions extends RunnerOptions {
  /**
   * Who this agent is. Every session it opens is stored under it, so a
   * transcript stays attributable to the prompt and tools that produced it.
   */
  agentId: string;
  /** Model used for compaction; defaults to the agent's main model. */
  compactionModel?: ModelConfig;
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
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit for a new session; pass one to resume it, or to name a new one. */
  sessionId?: string;
  title?: string;
}

const ROUTER_TOOL_NAME_SET = new Set<string>(ROUTER_TOOL_NAMES);

function mergeRisk(
  declared: ToolRisk | undefined,
  prepared: ToolRisk | undefined,
): ToolRisk | undefined {
  if (declared === undefined) return prepared;
  if (prepared === undefined) return declared;
  return {
    effects: [...new Set([...declared.effects, ...prepared.effects])],
    resources: [...(declared.resources ?? []), ...(prepared.resources ?? [])],
    reversible: prepared.reversible ?? declared.reversible,
    volume: prepared.volume ?? declared.volume,
  };
}

function bindTool(source: Tool, toolSetId: string): Tool {
  return Object.freeze({
    ...source,
    prepare: (params: Parameters<Tool['prepare']>[0]): ToolExecution => {
      const execution = source.prepare(params);
      return {
        ...execution,
        gateSubject: execution.gateSubject ?? { params, toolName: source.name, toolSetId },
        risk: mergeRisk(source.risk, execution.risk),
      };
    },
  });
}

function snapshotToolSets(
  grants: readonly ToolSetGrant[],
  kind: 'direct' | 'routed',
): Readonly<Record<string, Tool>> {
  const tools = new Map<string, Tool>();
  const toolSetIds = new Set<string>();

  for (const { toolSet, toolSetId } of [...grants]) {
    if (toolSetIds.has(toolSetId)) {
      throw new Error(`${kind} tool set ${toolSetId} is granted more than once.`);
    }
    toolSetIds.add(toolSetId);

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
      tools.set(name, bindTool(source, toolSetId));
    }
  }

  return Object.freeze(Object.fromEntries([...tools].sort(([a], [b]) => a.localeCompare(b))));
}

function composeSessionTools(
  directSource: readonly ToolSetGrant[],
  routedSource: readonly ToolSetGrant[],
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
  const routerTools = Object.fromEntries(
    Object.entries(router.tools).map(([name, tool]) => [name, bindTool(tool, 'nox.router')]),
  );
  return Object.freeze({ ...directTools, ...routerTools });
}

/**
 * A live agent: one provider, one model, one system prompt and a current tool-set
 * configuration. Every session resolves and snapshots its tools when opened, so
 * a later session may use newer sets without changing any session already alive.
 */
class Agent {
  readonly #agentId: string;
  readonly #compactionModel: ModelConfig;
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
    this.#compactionModel = options.compactionModel ?? model;
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
    const tools = composeSessionTools(this.#directToolSets, this.#routedToolSets);

    return Session.open(this.#database, this.#provider, this.#model, {
      ...options,
      agentId: this.#agentId,
      // The model's own window is the budget unless the agent overrode it.
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
