import { nanoid } from 'nanoid';
import { z } from 'zod';

import { closeDatabase, openDatabase, SessionStore } from '../database';
import { NotFoundError, ServiceUnavailableError } from '../errors';
import { ToolGate } from '../gate';
import { createLogger } from '../logger';
import { ProviderRegistry } from '../provider';
import { ToolRegistry } from '../tool/registry';

import { Context } from './context';
import { AgentSession } from './session';

import type { RunnerConfig } from '../config';
import type { NoxDatabase, RunListItem, RunSummary, RunStatus, SessionListItem, SessionRecord, StoredActivity, StoredMessage } from '../database';
import type { GateConfig } from '../gate';
import type { GatewayEvent } from '../gateway';
import type { Message } from '../provider';
import type { ToolSet } from '../tool';
import type { AgentStreamEvent } from './runner';

const logger = createLogger('agent');

const agentBlueprintSchema = z.object({
  id: z.string().regex(
    /^[a-zA-Z0-9_-]+$/,
    'Invalid agent blueprint ID'
  ).describe('The id of the agent blueprint.'),
  description: z.string().describe('A brief description of the agent\'s purpose and capabilities.'),
  systemPrompt: z.string().describe('The system prompt that defines the agent\'s behavior and personality.'),
  coreTools: z.array(z.string()).describe('The ids of the core tools that the agent can use.'),
  lazyLoadedTools: z.array(z.string()).describe('The ids of the tools that are loaded on demand when needed.'),
  config: z.object({
    providerId: z.string().describe('The id of the provider to use for this agent.'),
    modelId: z.string().describe('The id of the model to use for this agent.'),
    maxIterations: z.number().int().positive().describe('The maximum number of iterations the agent can perform before stopping.'),
  }).describe('The configuration for the agent, including provider and model information.'),
});

type AgentBlueprint = z.infer<typeof agentBlueprintSchema>;

class AgentRegistry {
  private static _instance: AgentRegistry;

  private database?: NoxDatabase;
  private store?: SessionStore;

  private agentBlueprints = new Map<string, AgentBlueprint>();
  private sessions = new Map<string, AgentSession>();
  private gateConfig: GateConfig = { rules: [], escalationTimeoutMs: 120_000 };
  private runnerConfig: RunnerConfig = { maxAttempts: 3, retryDelayMs: 1_000 };

  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): AgentRegistry {
    if (!AgentRegistry._instance) {
      AgentRegistry._instance = new AgentRegistry();
    }
    return AgentRegistry._instance;
  }

  public async init(
    agentBlueprints: AgentBlueprint[],
    databaseFile: string,
    gateConfig?: GateConfig,
    runnerConfig?: RunnerConfig,
  ): Promise<void> {
    if (this.initialized) {
      throw new Error('AgentRegistry already initialized.');
    }
    this.initialized = true;
    if (gateConfig) {
      this.gateConfig = gateConfig;
    }
    if (runnerConfig) {
      this.runnerConfig = runnerConfig;
    }

    try {
      for (const blueprint of agentBlueprints) {
        if (this.agentBlueprints.has(blueprint.id)) {
          throw new Error(`Duplicate agent blueprint "${blueprint.id}".`);
        }
        this.agentBlueprints.set(blueprint.id, blueprint);
      }
      this.database = openDatabase(databaseFile);
      this.store = new SessionStore(this.database);
      logger.info(
        { blueprints: [...this.agentBlueprints.keys()], databaseFile },
        'Agent registry initialized successfully.',
      );
    } catch (error) {
      this.initialized = false;
      this.agentBlueprints.clear();
      throw error;
    }
  }

  public createSession(blueprintId: string): { sessionId: string; session: AgentSession } {
    const store = this.requireStore();
    const blueprint = this.agentBlueprints.get(blueprintId);
    if (!blueprint) {
      throw new NotFoundError(`Agent blueprint with id ${blueprintId} not found.`);
    }
    const sessionId = nanoid();
    const context = new Context(blueprint.systemPrompt, sessionId);
    const session = this.buildSession(context, blueprint, sessionId);
    store.insertSession({
      sessionId,
      blueprintId: blueprint.id,
      systemPrompt: blueprint.systemPrompt,
    });
    this.attachPersistence(sessionId, context);
    this.sessions.set(sessionId, session);
    return { sessionId, session };
  }

  public restoreSession(sessionId: string): AgentSession {
    const store = this.requireStore();
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      return activeSession;
    }
    const sessionRecord = store.getSession(sessionId);
    if (!sessionRecord) {
      throw new NotFoundError(`Session with id ${sessionId} not found.`);
    }
    const blueprint = this.agentBlueprints.get(sessionRecord.blueprintId);
    if (!blueprint) {
      throw new NotFoundError(`Agent blueprint with id ${sessionRecord.blueprintId} for session ${sessionId} no longer exists.`);
    }
    const context = new Context(sessionRecord.systemPrompt, sessionId);
    for (const message of store.getMessages(sessionId)) {
      context.addMessage(message);
    }
    const session = this.buildSession(context, blueprint, sessionId);
    this.attachPersistence(sessionId, context);
    this.sessions.set(sessionId, session);
    return session;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const store = this.requireStore();
    const session = this.sessions.get(sessionId);
    if (!session && !store.getSession(sessionId)) {
      throw new NotFoundError(`Session with id ${sessionId} not found.`);
    }
    if (session) {
      await session.stop();
      this.sessions.delete(sessionId);
    }
    store.deleteSession(sessionId);
    logger.info({ sessionId }, 'Session deleted.');
  }

  public getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public getBlueprint(blueprintId: string): AgentBlueprint | null {
    return this.agentBlueprints.get(blueprintId) ?? null;
  }

  public listBlueprints(): AgentBlueprint[] {
    return [...this.agentBlueprints.values()];
  }

  public upsertBlueprint(blueprint: AgentBlueprint): void {
    this.agentBlueprints.set(blueprint.id, blueprint);
    logger.info({ blueprintId: blueprint.id }, 'Agent blueprint upserted.');
  }

  public removeBlueprint(blueprintId: string): void {
    this.agentBlueprints.delete(blueprintId);
    logger.info({ blueprintId }, 'Agent blueprint removed.');
  }

  public listSessions(blueprintId?: string): SessionRecord[] {
    return this.requireStore().listSessions(blueprintId);
  }

  public listSessionsWithStats(blueprintId?: string): SessionListItem[] {
    return this.requireStore().listSessionsWithStats(blueprintId);
  }

  public getSessionRecord(sessionId: string): SessionRecord | null {
    return this.requireStore().getSession(sessionId);
  }

  public listRuns(options: {
    blueprintId?: string;
    limit?: number;
    offset?: number;
    sessionId?: string;
    status?: RunStatus;
  }): RunListItem[] {
    return this.requireStore().listRuns(options);
  }

  public getSessionSnapshot(sessionId: string, activityLimit = 50): {
    activityCount: number;
    eventCursor: number;
    isRunning: boolean;
    latestRun: RunSummary | null;
    messageEntries: StoredMessage[];
    messages: readonly Message[];
    recentActivities: StoredActivity[];
    runs: RunListItem[];
    session: SessionRecord;
  } {
    const record = this.requireStore().getSession(sessionId);
    if (!record) {
      throw new NotFoundError(`Session with id ${sessionId} not found.`);
    }
    const activeSession = this.sessions.get(sessionId);
    const store = this.requireStore();
    const messageEntries = store.getMessageEntries(sessionId);
    return {
      activityCount: store.getActivityCount(sessionId),
      eventCursor: activeSession?.eventCursor ?? 0,
      isRunning: activeSession?.isRunning ?? false,
      latestRun: store.getLatestRun(sessionId),
      messageEntries,
      messages: messageEntries.map((entry) => entry.message),
      recentActivities: store.getRecentActivities(sessionId, activityLimit),
      runs: store.listRuns({ sessionId, limit: 500 }),
      session: record,
    };
  }

  public close(): void {
    if (this.database) {
      closeDatabase(this.database);
    }
    this.database = undefined;
    this.store = undefined;
  }

  private requireStore(): SessionStore {
    if (!this.store) {
      throw new Error('AgentRegistry not initialized. Call init() before using it.');
    }
    return this.store;
  }

  private attachPersistence(sessionId: string, context: Context): void {
    const store = this.requireStore();
    context.listener = {
      onMessageAdded: (index, message): void => {
        try {
          store.saveMessage(sessionId, index, message);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Failed to persist session message.');
        }
      },
      onHistoryTruncated: (length): void => {
        try {
          store.truncateMessages(sessionId, length);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Failed to truncate persisted session messages.');
        }
      },
    };
  }

  private createToolSets(blueprintId: string, toolSetIds: string[]): ToolSet[] {
    const toolSets: ToolSet[] = [];
    for (const toolSetId of toolSetIds) {
      const toolSet = ToolRegistry.instance.createToolSet(toolSetId);
      if (!toolSet) {
        logger.warn({ blueprintId, toolSetId }, 'Tool set not found for agent blueprint, dropping it.');
        continue;
      }
      toolSets.push(toolSet);
    }
    return toolSets;
  }

  private buildSession(context: Context, blueprint: AgentBlueprint, sessionId: string): AgentSession {
    const coreToolSets = this.createToolSets(blueprint.id, blueprint.coreTools);
    const lazyLoadedToolSets = this.createToolSets(blueprint.id, blueprint.lazyLoadedTools);
    const RouterToolSetClass = ToolRegistry.instance.getRouterToolSetClass();
    if (!RouterToolSetClass) {
      throw new Error('Tool router not found, cannot create agent session.');
    }
    coreToolSets.push(new RouterToolSetClass(
      lazyLoadedToolSets.flatMap((toolSet) => Object.values(toolSet.tools))
    ));
    context.tools = Object.fromEntries(
      coreToolSets.flatMap((toolSet) => Object.entries(toolSet.tools))
    );

    const provider = ProviderRegistry.instance.getProvider(blueprint.config.providerId);
    if (!provider) {
      throw new ServiceUnavailableError(`Provider with id ${blueprint.config.providerId} is not active.`);
    }
    const modelConfig = provider.getModelConfig(blueprint.config.modelId);
    if (!modelConfig) {
      throw new ServiceUnavailableError(`Model with id ${blueprint.config.modelId} is not active in provider ${blueprint.config.providerId}.`);
    }

    const gateRules = [
      ...[...coreToolSets, ...lazyLoadedToolSets].flatMap((toolSet) => toolSet.gate ?? []),
      ...this.gateConfig.rules,
    ];

    return new AgentSession(context, {
      maxAttempts: this.runnerConfig.maxAttempts,
      maxIterations: blueprint.config.maxIterations,
      modelConfig,
      provider,
      retryDelayMs: this.runnerConfig.retryDelayMs,
      gate: new ToolGate(gateRules),
      escalationTimeoutMs: this.gateConfig.escalationTimeoutMs,
      onEvent: (event): void => {
        try {
          this.requireStore().recordEvent(sessionId, toGatewayEvent(event));
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Failed to persist session event.');
        }
      },
    });
  }
}

function toGatewayEvent(event: AgentStreamEvent): GatewayEvent {
  if (event.type === 'error') {
    return { type: 'error', message: event.error.message };
  }
  return event;
}

export {
  AgentRegistry,
  agentBlueprintSchema,
};

export type {
  AgentBlueprint,
};
