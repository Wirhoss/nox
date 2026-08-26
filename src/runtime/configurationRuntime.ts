import { Agent } from '../agent/agent';
import { composeWithSecrets, type SecretStore } from '../config/secrets';
import { type ProviderConfig, providers } from '../extensions/contribution-points/providers';
import { stableStringify } from '../utils/json';
import { Mutex } from '../utils/mutex';

import type { NoxApplication } from '../application';
import type { ArtifactPipeline } from '../artifact/pipeline';
import type { AuthorityCatalog } from '../auth/authority';
import type { Blueprint, TaskModelConfig } from '../config/blueprint';
import type { Config } from '../config/config';
import type { Database } from '../database/database';
import type { ContributionReader } from '../extensions/contribution';
import type { ToolSetCatalog } from '../extensions/toolSetCatalog';
import type { BrokerGrant, Gateway } from '../gateway/gateway';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';

type RuntimeComponentKind = 'agent' | 'application' | 'broker' | 'provider' | 'toolSet';
type RuntimeComponentState = 'active' | 'applying' | 'failed' | 'restartRequired' | 'unavailable';

interface RuntimeComponentStatus {
  readonly activeGeneration?: number;
  readonly desiredGeneration: number;
  readonly error?: string;
  readonly id: string;
  readonly kind: RuntimeComponentKind;
  readonly state: RuntimeComponentState;
}

interface ConfigurationRuntime {
  reconcile(): Promise<void>;
  statuses(): readonly RuntimeComponentStatus[];
}

interface ConfigurationRuntimeOptions {
  readonly application: NoxApplication;
  readonly artifacts: ArtifactPipeline;
  readonly authorities: AuthorityCatalog;
  readonly config: Config;
  readonly contributions: ContributionReader;
  readonly createBroker?: (brokerId: string) => Promise<BrokerGrant>;
  readonly database: Database;
  readonly logger: Logger;
  readonly secretStore: SecretStore;
  readonly toolSets: ToolSetCatalog;
}

interface ActiveProvider {
  readonly provider: ChatProvider;
  readonly signature: string;
}

interface TaskModel {
  readonly model: ModelConfig;
  readonly provider: ChatProvider;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function key(kind: RuntimeComponentKind, id: string): string {
  return `${kind}\u0000${id}`;
}

/**
 * Reconciles the desired configuration into independently replaceable runtime
 * components. Failed candidates never evict the last generation that worked.
 */
/** Stable API-facing handle connected once the concrete runtime has composed. */
class ConfigurationRuntimeRelay implements ConfigurationRuntime {
  #host?: ConfigurationRuntime;

  public connect(host: ConfigurationRuntime): void {
    this.#host = host;
  }

  public reconcile(): Promise<void> {
    return this.#host?.reconcile() ?? Promise.resolve();
  }

  public statuses(): readonly RuntimeComponentStatus[] {
    return this.#host?.statuses() ?? [];
  }
}

class ConfigurationRuntimeController implements ConfigurationRuntime {
  readonly #activeBrokerAgentIds = new Map<string, ReadonlySet<string>>();
  readonly #agentSignatures = new Map<string, string>();
  readonly #application: NoxApplication;
  readonly #artifacts: ArtifactPipeline;
  readonly #authorities: AuthorityCatalog;
  readonly #brokerSignatures = new Map<string, string>();
  readonly #config: Config;
  readonly #contributions: ContributionReader;
  readonly #createBroker?: (brokerId: string) => Promise<BrokerGrant>;
  readonly #database: Database;
  readonly #logger: Logger;
  readonly #mutex = new Mutex();
  readonly #providers = new Map<string, ActiveProvider>();
  readonly #secretStore: SecretStore;
  readonly #statuses = new Map<string, RuntimeComponentStatus>();
  readonly #toolSets: ToolSetCatalog;

  #gateway?: Gateway;
  #generation = 0;

  constructor(options: ConfigurationRuntimeOptions) {
    this.#application = options.application;
    this.#artifacts = options.artifacts;
    this.#authorities = options.authorities;
    this.#config = options.config;
    this.#contributions = options.contributions;
    this.#createBroker = options.createBroker;
    this.#database = options.database;
    this.#logger = options.logger.child('runtime-config');
    this.#secretStore = options.secretStore;
    this.#toolSets = options.toolSets;
  }

  public connectGateway(gateway: Gateway): void {
    this.#gateway = gateway;
  }

  public reportBroker(
    brokerId: string,
    state: Extract<RuntimeComponentState, 'active' | 'failed' | 'unavailable'>,
    error?: string,
  ): void {
    const generation = Math.max(1, this.#generation);
    this.#statuses.set(key('broker', brokerId), {
      ...(state === 'active' ? { activeGeneration: generation } : {}),
      desiredGeneration: generation,
      ...(error === undefined ? {} : { error }),
      id: brokerId,
      kind: 'broker',
      state,
    });
  }

  public reconcile(): Promise<void> {
    return this.#mutex.run(async () => {
      const generation = ++this.#generation;
      this.#logger.setLevel?.(this.#config.get('app').logLevel);
      await this.#attempt('providers', () => this.#reconcileProviders(generation));
      await this.#attempt('tool sets', () => this.#reconcileToolSets(generation));
      await this.#attempt('agents', () => this.#reconcileAgents(generation));
      await this.#attempt('brokers', () => this.#reconcileBrokers(generation));
      await this.#attempt('retired agents', () => this.#reconcileAgentRemovals(generation));
    });
  }

  public statuses(): readonly RuntimeComponentStatus[] {
    return Object.freeze(
      [...this.#statuses.values()].sort((left, right) => {
        const byKind = left.kind.localeCompare(right.kind);
        return byKind === 0 ? left.id.localeCompare(right.id) : byKind;
      }),
    );
  }

  async #attempt(name: string, reconcile: () => Promise<void>): Promise<void> {
    try {
      await reconcile();
    } catch (error) {
      this.#logger.error({ err: error }, `Could not reconcile ${name}.`);
    }
  }

  async #reconcileBrokers(generation: number): Promise<void> {
    if (this.#gateway === undefined || this.#createBroker === undefined) return;
    const configured = this.#config.get('brokers');
    const desired = new Set(Object.keys(configured));

    for (const [brokerId, entry] of Object.entries(configured)) {
      const signature = stableStringify({
        agentIds: this.#desiredAgentIds(),
        entry,
        secretRevision: this.#secretStore.revision,
      });
      const activeSignature = this.#brokerSignatures.get(brokerId);
      if (activeSignature === signature) {
        this.#active('broker', brokerId, generation);
        continue;
      }

      this.#applying('broker', brokerId, generation, activeSignature !== undefined);
      try {
        if (entry.enabled === false) {
          await this.#gateway.removeBroker(brokerId);
          this.#activeBrokerAgentIds.delete(brokerId);
        } else {
          const grant = await this.#createBroker(brokerId);
          await this.#gateway.replaceBroker(grant);
          this.#activeBrokerAgentIds.set(brokerId, this.#grantAgentIds(grant));
        }
        this.#brokerSignatures.set(brokerId, signature);
        this.#active('broker', brokerId, generation);
      } catch (error) {
        const stillActive = this.#gateway.brokerIds.includes(brokerId);
        const activeGeneration = this.#statuses.get(key('broker', brokerId))?.activeGeneration;
        this.#statuses.set(key('broker', brokerId), {
          ...(stillActive && activeGeneration !== undefined ? { activeGeneration } : {}),
          desiredGeneration: generation,
          error: message(error),
          id: brokerId,
          kind: 'broker',
          state: activeSignature === undefined || !stillActive ? 'unavailable' : 'failed',
        });
        this.#logger.error({ brokerId, err: error }, 'Broker configuration did not activate.');
      }
    }

    const visible = new Set(desired);
    for (const brokerId of this.#brokerSignatures.keys()) {
      if (desired.has(brokerId)) continue;
      try {
        await this.#gateway.removeBroker(brokerId);
        this.#activeBrokerAgentIds.delete(brokerId);
        this.#brokerSignatures.delete(brokerId);
      } catch (error) {
        visible.add(brokerId);
        const stillActive = this.#gateway.brokerIds.includes(brokerId);
        const activeGeneration = this.#statuses.get(key('broker', brokerId))?.activeGeneration;
        this.#statuses.set(key('broker', brokerId), {
          ...(stillActive && activeGeneration !== undefined ? { activeGeneration } : {}),
          desiredGeneration: generation,
          error: message(error),
          id: brokerId,
          kind: 'broker',
          state: stillActive ? 'failed' : 'unavailable',
        });
        this.#logger.error({ brokerId, err: error }, 'Broker removal did not activate.');
      }
    }
    this.#dropAbsent('broker', visible);
  }

  async #reconcileProviders(generation: number): Promise<void> {
    const configured = this.#config.get('providers');
    const desired = new Set(Object.keys(configured));

    for (const [providerId, entry] of Object.entries(configured)) {
      const componentKey = key('provider', providerId);
      const signature = stableStringify({ entry, secretRevision: this.#secretStore.revision });
      const active = this.#providers.get(providerId);
      if (active?.signature === signature) {
        this.#active('provider', providerId, generation);
        continue;
      }

      this.#applying('provider', providerId, generation, active !== undefined);
      try {
        const provider = await this.#createProvider(providerId, entry);
        this.#providers.set(providerId, { provider, signature });
        this.#active('provider', providerId, generation);
      } catch (error) {
        const activeGeneration = this.#statuses.get(componentKey)?.activeGeneration;
        this.#statuses.set(componentKey, {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: message(error),
          id: providerId,
          kind: 'provider',
          state: active === undefined ? 'unavailable' : 'failed',
        });
        this.#logger.error({ err: error, providerId }, 'Provider configuration did not activate.');
      }
    }

    const visible = new Set(desired);
    for (const providerId of this.#providers.keys()) {
      if (desired.has(providerId)) continue;
      const reference = this.#providerReference(providerId);
      if (reference !== undefined) {
        visible.add(providerId);
        const activeGeneration = this.#statuses.get(key('provider', providerId))?.activeGeneration;
        this.#statuses.set(key('provider', providerId), {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: reference,
          id: providerId,
          kind: 'provider',
          state: 'failed',
        });
        continue;
      }
      this.#providers.delete(providerId);
    }
    this.#dropAbsent('provider', visible);
  }

  async #createProvider(providerId: string, entry: ProviderConfig): Promise<ChatProvider> {
    const contribution = this.#contributions.get(providers, entry.type);
    if (contribution === undefined) {
      throw new Error(
        `Provider "${providerId}" is of type "${entry.type}", which no extension contributed.`,
      );
    }
    return composeWithSecrets(
      entry,
      this.#secretStore,
      { extensionId: contribution.extensionId, location: `providers.${providerId}` },
      (resolved) => contribution.value.create(resolved),
    );
  }

  async #reconcileToolSets(generation: number): Promise<void> {
    const configuredIds = new Set(this.#toolSets.configuredIds);
    const retained = [...this.#statuses.values()]
      .filter((status) => status.kind === 'toolSet' && !configuredIds.has(status.id))
      .map((status) => ({ reference: this.#toolSetReference(status.id), status }))
      .filter(
        (
          candidate,
        ): candidate is {
          reference: string;
          status: RuntimeComponentStatus;
        } => candidate.reference !== undefined,
      );
    for (const toolSetId of configuredIds) {
      this.#applying(
        'toolSet',
        toolSetId,
        generation,
        this.#toolSets.problem(toolSetId) === undefined,
      );
    }
    await this.#toolSets.refresh();
    for (const toolSetId of configuredIds) {
      const problem = this.#toolSets.problem(toolSetId);
      if (problem === undefined) this.#active('toolSet', toolSetId, generation);
      else {
        const activeGeneration = this.#statuses.get(key('toolSet', toolSetId))?.activeGeneration;
        this.#statuses.set(key('toolSet', toolSetId), {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: problem,
          id: toolSetId,
          kind: 'toolSet',
          state: activeGeneration === undefined ? 'unavailable' : 'failed',
        });
      }
    }
    const visible = new Set(configuredIds);
    for (const { reference, status } of retained) {
      visible.add(status.id);
      this.#statuses.set(key('toolSet', status.id), {
        ...(status.activeGeneration === undefined
          ? {}
          : { activeGeneration: status.activeGeneration }),
        desiredGeneration: generation,
        error: reference,
        id: status.id,
        kind: 'toolSet',
        state: status.activeGeneration === undefined ? 'unavailable' : 'failed',
      });
    }
    this.#dropAbsent('toolSet', visible);
  }

  async #reconcileAgents(generation: number): Promise<void> {
    const blueprints = this.#config.get('blueprints');
    const timeZone = this.#config.get('app').timezone;

    for (const [agentId, blueprint] of Object.entries(blueprints)) {
      const signature = this.#agentSignature(blueprint, timeZone);
      if (this.#agentSignatures.get(agentId) === signature) {
        this.#active('agent', agentId, generation);
        continue;
      }

      const existing = this.#application.getAgent(agentId);
      this.#applying('agent', agentId, generation, existing !== undefined);
      try {
        const agent = await this.#createAgent(agentId, blueprint, timeZone);
        this.#application.replaceAgent(agent);
        this.#agentSignatures.set(agentId, signature);
        this.#active('agent', agentId, generation);
        if (existing !== undefined) await this.#gateway?.retireAgentSessions(agentId);
      } catch (error) {
        const activeGeneration = this.#statuses.get(key('agent', agentId))?.activeGeneration;
        this.#statuses.set(key('agent', agentId), {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: message(error),
          id: agentId,
          kind: 'agent',
          state: existing === undefined ? 'unavailable' : 'failed',
        });
        this.#logger.error({ agentId, err: error }, 'Agent configuration did not activate.');
      }
    }
  }

  async #reconcileAgentRemovals(generation: number): Promise<void> {
    const desired = new Set(Object.keys(this.#config.get('blueprints')));
    const visible = new Set(desired);
    for (const agentId of this.#application.agentIds) {
      if (desired.has(agentId)) continue;
      const route = this.#agentRouteReference(agentId);
      if (route !== undefined) {
        visible.add(agentId);
        const activeGeneration = this.#statuses.get(key('agent', agentId))?.activeGeneration;
        this.#statuses.set(key('agent', agentId), {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: route,
          id: agentId,
          kind: 'agent',
          state: 'failed',
        });
        continue;
      }
      this.#application.removeAgent(agentId);
      this.#agentSignatures.delete(agentId);
      await this.#gateway?.retireAgentSessions(agentId);
    }
    this.#dropAbsent('agent', visible);
  }

  async #createAgent(agentId: string, blueprint: Blueprint, timeZone: string): Promise<Agent> {
    const provider = this.#requiredProvider(blueprint.provider);
    const model = modelConfigFor(provider, blueprint.model, blueprint.generation);
    const openTask = (task: TaskModelConfig | undefined): TaskModel => {
      if (task === undefined) return { model, provider };
      const taskProvider =
        task.provider === undefined ? provider : this.#requiredProvider(task.provider);
      return { model: modelConfigFor(taskProvider, task.model), provider: taskProvider };
    };
    const compaction = openTask(blueprint.taskModels.compaction);
    const title = openTask(blueprint.taskModels.title);

    for (const grant of [...blueprint.toolSets.direct, ...blueprint.toolSets.routed]) {
      const toolSetId = typeof grant === 'string' ? grant : grant.id;
      const problem = this.#toolSets.problem(toolSetId);
      if (problem !== undefined)
        throw new Error(`Tool set "${toolSetId}" is unavailable: ${problem}`);
    }

    const directToolSets = await this.#toolSets.grant(blueprint.toolSets.direct);
    const routedToolSets = await this.#toolSets.grant(blueprint.toolSets.routed);
    return new Agent(this.#database, provider, model, {
      agentId,
      artifacts: this.#artifacts,
      authorities: this.#authorities,
      compactionModel: compaction.model,
      compactionProvider: compaction.provider,
      context: blueprint.context,
      directToolSets,
      gate: blueprint.gate,
      logger: this.#logger,
      maxIterations: blueprint.maxIterations,
      routedToolSets,
      systemPrompt: blueprint.systemPrompt,
      timeZone,
      titleModel: title.model,
      titleProvider: title.provider,
    });
  }

  #desiredAgentIds(): readonly string[] {
    return Object.keys(this.#config.get('blueprints'))
      .filter((agentId) => this.#application.getAgent(agentId) !== undefined)
      .sort((left, right) => left.localeCompare(right));
  }

  #grantAgentIds(grant: BrokerGrant): ReadonlySet<string> {
    const agentIds = new Set<string>();
    if (grant.agentId !== undefined) agentIds.add(grant.agentId);
    for (const conversation of Object.values(grant.conversations ?? {})) {
      if (conversation.agentId !== undefined) agentIds.add(conversation.agentId);
    }
    return agentIds;
  }

  #providerReference(providerId: string): string | undefined {
    for (const [agentId, blueprint] of Object.entries(this.#config.get('blueprints'))) {
      if (
        blueprint.provider === providerId ||
        blueprint.taskModels.compaction?.provider === providerId ||
        blueprint.taskModels.title?.provider === providerId
      ) {
        return `Agent "${agentId}" still depends on this provider.`;
      }
    }
    return undefined;
  }

  #toolSetReference(toolSetId: string): string | undefined {
    for (const [agentId, blueprint] of Object.entries(this.#config.get('blueprints'))) {
      const referenced = [...blueprint.toolSets.direct, ...blueprint.toolSets.routed].some(
        (grant) => (typeof grant === 'string' ? grant : grant.id) === toolSetId,
      );
      if (referenced) return `Agent "${agentId}" still depends on this tool set.`;
    }
    return undefined;
  }

  #agentRouteReference(agentId: string): string | undefined {
    for (const [brokerId, broker] of Object.entries(this.#config.get('brokers'))) {
      if (broker.enabled === false) continue;
      if (broker.agent === agentId) {
        return `Broker "${brokerId}" still routes new conversations to this agent.`;
      }
      for (const [conversationId, override] of Object.entries(broker.conversations)) {
        if (override.agent === agentId) {
          return `Broker "${brokerId}" conversation "${conversationId}" still routes to this agent.`;
        }
      }
    }
    for (const [brokerId, agentIds] of this.#activeBrokerAgentIds) {
      if (agentIds.has(agentId)) {
        return `Active broker "${brokerId}" still routes new conversations to this agent.`;
      }
    }
    return undefined;
  }

  #requiredProvider(providerId: string): ChatProvider {
    const status = this.#statuses.get(key('provider', providerId));
    const active = this.#providers.get(providerId);
    if (active === undefined) {
      throw new Error(
        status?.error === undefined
          ? `Provider "${providerId}" is not configured.`
          : `Provider "${providerId}" is unavailable: ${status.error}`,
      );
    }
    if (status?.state === 'failed') {
      throw new Error(
        `Provider "${providerId}" did not activate: ${status.error ?? 'unknown error'}`,
      );
    }
    return active.provider;
  }

  #agentSignature(blueprint: Blueprint, timeZone: string): string {
    const providerIds = [
      blueprint.provider,
      blueprint.taskModels.compaction?.provider,
      blueprint.taskModels.title?.provider,
    ].filter((value): value is string => value !== undefined);
    const toolSetIds = [...blueprint.toolSets.direct, ...blueprint.toolSets.routed].map((grant) =>
      typeof grant === 'string' ? grant : grant.id,
    );
    const configuredProviders = this.#config.get('providers');
    const configuredToolSets = this.#config.get('toolSets');
    return stableStringify({
      blueprint,
      providers: Object.fromEntries(providerIds.map((id) => [id, configuredProviders[id]])),
      secretRevision: this.#secretStore.revision,
      timeZone,
      toolSets: Object.fromEntries(toolSetIds.map((id) => [id, configuredToolSets[id]])),
    });
  }

  #active(kind: RuntimeComponentKind, id: string, generation: number): void {
    this.#statuses.set(key(kind, id), {
      activeGeneration: generation,
      desiredGeneration: generation,
      id,
      kind,
      state: 'active',
    });
  }

  #applying(kind: RuntimeComponentKind, id: string, generation: number, hasActive: boolean): void {
    const activeGeneration = this.#statuses.get(key(kind, id))?.activeGeneration;
    this.#statuses.set(key(kind, id), {
      ...(hasActive ? { activeGeneration: activeGeneration ?? Math.max(1, generation - 1) } : {}),
      desiredGeneration: generation,
      id,
      kind,
      state: 'applying',
    });
  }

  #dropAbsent(kind: RuntimeComponentKind, desired: ReadonlySet<string>): void {
    for (const [componentKey, status] of this.#statuses) {
      if (status.kind === kind && !desired.has(status.id)) this.#statuses.delete(componentKey);
    }
  }
}

function modelConfigFor(
  provider: ChatProvider,
  modelId: string,
  generation: Blueprint['generation'] = {},
): ModelConfig {
  const configured = provider.getModelConfig(modelId) ?? {
    inputModalities: ['text'] as const,
    modelId,
    outputModalities: ['text'] as const,
  };
  return { ...configured, ...generation };
}

export { ConfigurationRuntimeController, ConfigurationRuntimeRelay };

export type {
  ConfigurationRuntime,
  ConfigurationRuntimeOptions,
  RuntimeComponentKind,
  RuntimeComponentState,
  RuntimeComponentStatus,
};
