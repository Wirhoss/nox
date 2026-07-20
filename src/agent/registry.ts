import { nanoid } from 'nanoid';
import { z } from 'zod';

import { closeDatabase, openDatabase, SessionStore } from '../database';
import { createLogger } from '../logger';
import { ProviderRegistry } from '../provider';
import { ToolRegistry } from '../tool/registry';

import { Context } from './context';
import { AgentSession } from './session';

import type { NoxDatabase, SessionRecord } from '../database';
import type { ToolSet } from '../tool';

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

  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): AgentRegistry {
    if (!AgentRegistry._instance) {
      AgentRegistry._instance = new AgentRegistry();
    }
    return AgentRegistry._instance;
  }

  public async init(agentBlueprints: AgentBlueprint[], databaseFile: string): Promise<void> {
    if (this.initialized) {
      throw new Error('AgentRegistry already initialized.');
    }
    this.initialized = true;

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
      throw new Error(`Agent blueprint with id ${blueprintId} not found.`);
    }
    const sessionId = nanoid();
    const context = new Context(blueprint.systemPrompt, sessionId);
    const session = this.buildSession(context, blueprint);
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
      throw new Error(`Session with id ${sessionId} not found.`);
    }
    const blueprint = this.agentBlueprints.get(sessionRecord.blueprintId);
    if (!blueprint) {
      throw new Error(`Agent blueprint with id ${sessionRecord.blueprintId} for session ${sessionId} no longer exists.`);
    }
    const context = new Context(sessionRecord.systemPrompt, sessionId);
    for (const message of store.getMessages(sessionId)) {
      context.addMessage(message);
    }
    const session = this.buildSession(context, blueprint);
    this.attachPersistence(sessionId, context);
    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public listSessions(): SessionRecord[] {
    return this.requireStore().listSessions();
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

  /**
   * Persistence must never break a running session: storage errors are logged
   * and swallowed so the in-memory context stays authoritative.
   */
  private attachPersistence(sessionId: string, context: Context): void {
    const store = this.requireStore();
    context.listener = {
      onMessageAdded: (index, message) => {
        try {
          store.saveMessage(sessionId, index, message);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'Failed to persist session message.');
        }
      },
      onHistoryTruncated: (length) => {
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
      const ToolSetClass = ToolRegistry.instance.getToolSetClass(toolSetId);
      if (!ToolSetClass) {
        logger.warn({ blueprintId, toolSetId }, 'Tool set not found for agent blueprint, dropping it.');
        continue;
      }
      toolSets.push(new ToolSetClass());
    }
    return toolSets;
  }

  private buildSession(context: Context, blueprint: AgentBlueprint): AgentSession {
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
      throw new Error(`Provider with id ${blueprint.config.providerId} not found.`);
    }
    const modelConfig = provider.getModelConfig(blueprint.config.modelId);
    if (!modelConfig) {
      throw new Error(`Model with id ${blueprint.config.modelId} not found in provider ${blueprint.config.providerId}.`);
    }
    return new AgentSession(context, {
      maxIterations: blueprint.config.maxIterations,
      modelConfig,
      provider,
    });
  }
}

export {
  AgentRegistry,
  agentBlueprintSchema,
};

export type {
  AgentBlueprint,
};
