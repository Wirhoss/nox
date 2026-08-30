import {
  type BaseProvider,
  type ChatModelConfig,
  type ChatProvider,
  type ContributionReader,
  type Disposable,
  isChatCapable,
  isDisposable,
  memories,
  type Memory,
  type MemoryConfig,
  type ProviderConfig,
  providers,
  type RuntimeComponentKind,
  type RuntimeComponentState,
  type RuntimeComponentStatus,
} from '@nox/extension-api';

import { Agent } from '../agent/agent';
import { memoryToolSetGrant } from '../agent/memoryToolSet';
import { composeSessionTools } from '../agent/tools';
import { composeWithSecrets, type SecretStore } from '../config/secrets';
import { stableStringify } from '../utils/json';
import { Mutex } from '../utils/mutex';

import type { NoxApplication } from '../application';
import type { ArtifactPipeline } from '../artifact/pipeline';
import type { AuthorityCatalog } from '../auth/authority';
import type { Blueprint, TaskModelConfig } from '../config/blueprint';
import type { Config } from '../config/config';
import type { Database } from '../database/database';
import type { ToolSetCatalog } from '../extensions/toolSetCatalog';
import type { BrokerGrant, Gateway } from '../gateway/gateway';
import type { Logger } from '../logger/logger';
import type { ProviderRegistry } from './modelAccess';

interface ConfigurationRuntime {
  reconcile(): Promise<void>;
  statuses(): readonly RuntimeComponentStatus[];
}

interface RuntimeMemorySummary {
  readonly editable: boolean;
  readonly id: string;
  readonly inspectable: boolean;
}

/** Active memory generations exposed only to the owner-facing audit API. */
interface MemoryRuntime {
  memory(memoryId: string): Memory | undefined;
  memoryInventory(): readonly RuntimeMemorySummary[];
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

interface ActiveMemory {
  readonly memory: Memory;
  readonly signature: string;
}

interface ActiveProvider {
  readonly provider: BaseProvider;
  readonly signature: string;
}

interface TaskModel {
  readonly model: ChatModelConfig;
  readonly provider: ChatProvider;
}

type InstanceKind = 'memory' | 'provider' | 'toolSet';

/** One instance the configuration has replaced or dropped, waiting to be released. */
interface SupersededInstance {
  readonly id: string;
  readonly instance: Disposable;
  readonly kind: InstanceKind;
}

function blueprintUses(blueprint: Blueprint, kind: InstanceKind, id: string): boolean {
  if (kind === 'memory') return blueprint.memory?.id === id;
  if (kind === 'toolSet') {
    return [...blueprint.toolSets.direct, ...blueprint.toolSets.routed].some(
      (grant) => (typeof grant === 'string' ? grant : grant.id) === id,
    );
  }
  // A task model without its own provider runs on the agent's, so naming the
  // blueprint's provider is what covers every task that did not name one.
  return (
    blueprint.provider === id ||
    blueprint.taskModels.compaction?.provider === id ||
    blueprint.taskModels.title?.provider === id
  );
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
class ConfigurationRuntimeRelay implements ConfigurationRuntime, MemoryRuntime {
  #host?: ConfigurationRuntime & MemoryRuntime;

  public connect(host: ConfigurationRuntime & MemoryRuntime): void {
    this.#host = host;
  }

  public memory(memoryId: string): Memory | undefined {
    return this.#host?.memory(memoryId);
  }

  public memoryInventory(): readonly RuntimeMemorySummary[] {
    return this.#host?.memoryInventory() ?? [];
  }

  public reconcile(): Promise<void> {
    return this.#host?.reconcile() ?? Promise.resolve();
  }

  public statuses(): readonly RuntimeComponentStatus[] {
    return this.#host?.statuses() ?? [];
  }

  /**
   * Held by the application from the start, because the concrete runtime is
   * composed after Nox is already running and can no longer be handed one.
   */
  public async dispose(): Promise<void> {
    if (isDisposable(this.#host)) await this.#host.dispose();
  }
}

class ConfigurationRuntimeController
  implements ConfigurationRuntime, MemoryRuntime, ProviderRegistry
{
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
  readonly #memories = new Map<string, ActiveMemory>();
  readonly #mutex = new Mutex();
  readonly #providers = new Map<string, ActiveProvider>();
  readonly #secretStore: SecretStore;
  readonly #statuses = new Map<string, RuntimeComponentStatus>();
  readonly #superseded: SupersededInstance[] = [];
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
      await this.#attempt('memories', () => this.#reconcileMemories(generation));
      await this.#attempt('tool sets', () => this.#reconcileToolSets(generation));
      await this.#attempt('agents', () => this.#reconcileAgents(generation));
      await this.#attempt('brokers', () => this.#reconcileBrokers(generation));
      await this.#attempt('retired agents', () => this.#reconcileAgentRemovals(generation));
      // Last, and only here: an instance replaced earlier in this pass may still
      // be held by an agent that has not been rebuilt yet.
      await this.#attempt('superseded instances', () => this.#releaseSuperseded(generation));
    });
  }

  /**
   * Releases every instance this runtime created, whether or not an agent is
   * still holding it. Called once the application has closed its sessions, so
   * by then nothing is.
   */
  public async dispose(): Promise<void> {
    for (const [providerId, active] of this.#providers) {
      this.#supersede('provider', providerId, active.provider);
    }
    this.#providers.clear();
    for (const [memoryId, active] of this.#memories) {
      this.#supersede('memory', memoryId, active.memory);
    }
    this.#memories.clear();
    this.#toolSets.retire();
    for (const { id, instance } of this.#toolSets.takeSuperseded()) {
      this.#superseded.push({ id, instance, kind: 'toolSet' });
    }
    for (const entry of this.#superseded) await this.#release(entry);
    this.#superseded.length = 0;
  }

  /**
   * One activated provider instance, by the name it is configured under.
   *
   * Public because an extension reaches a model through `ModelAccess`, and what
   * it is allowed to reach is exactly what an agent is: an instance this pass
   * brought up. Which contract that instance can answer is left to the caller,
   * because chat and embedding refuse for different reasons and each says so in
   * its own terms.
   */
  public memory(memoryId: string): Memory | undefined {
    return this.#memories.get(memoryId)?.memory;
  }

  public memoryInventory(): readonly RuntimeMemorySummary[] {
    return Object.freeze(
      [...this.#memories.entries()]
        .map(([id, { memory }]) => ({
          editable: memory.editor !== undefined,
          id,
          inspectable: memory.inspector !== undefined,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  public provider(providerId: string): BaseProvider {
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
        if (active !== undefined) this.#supersede('provider', providerId, active.provider);
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
      const dropped = this.#providers.get(providerId);
      this.#providers.delete(providerId);
      if (dropped !== undefined) this.#supersede('provider', providerId, dropped.provider);
    }
    this.#dropAbsent('provider', visible);
  }

  async #createProvider(providerId: string, entry: ProviderConfig): Promise<BaseProvider> {
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

  async #reconcileMemories(generation: number): Promise<void> {
    const configured = this.#config.get('memories');
    const desired = new Set(Object.keys(configured));

    for (const [memoryId, entry] of Object.entries(configured)) {
      const componentKey = key('memory', memoryId);
      const signature = stableStringify({ entry, secretRevision: this.#secretStore.revision });
      const active = this.#memories.get(memoryId);
      if (active?.signature === signature) {
        this.#active('memory', memoryId, generation);
        continue;
      }

      this.#applying('memory', memoryId, generation, active !== undefined);
      try {
        const memory = await this.#createMemory(memoryId, entry);
        this.#memories.set(memoryId, { memory, signature });
        if (active !== undefined) this.#supersede('memory', memoryId, active.memory);
        this.#active('memory', memoryId, generation);
      } catch (error) {
        const activeGeneration = this.#statuses.get(componentKey)?.activeGeneration;
        this.#statuses.set(componentKey, {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: message(error),
          id: memoryId,
          kind: 'memory',
          state: active === undefined ? 'unavailable' : 'failed',
        });
        this.#logger.error({ err: error, memoryId }, 'Memory configuration did not activate.');
      }
    }

    const visible = new Set(desired);
    for (const memoryId of this.#memories.keys()) {
      if (desired.has(memoryId)) continue;
      const reference = this.#memoryReference(memoryId);
      if (reference !== undefined) {
        visible.add(memoryId);
        const activeGeneration = this.#statuses.get(key('memory', memoryId))?.activeGeneration;
        this.#statuses.set(key('memory', memoryId), {
          ...(activeGeneration === undefined ? {} : { activeGeneration }),
          desiredGeneration: generation,
          error: reference,
          id: memoryId,
          kind: 'memory',
          state: 'failed',
        });
        continue;
      }
      const dropped = this.#memories.get(memoryId);
      this.#memories.delete(memoryId);
      if (dropped !== undefined) this.#supersede('memory', memoryId, dropped.memory);
    }
    this.#dropAbsent('memory', visible);
  }

  async #createMemory(memoryId: string, entry: MemoryConfig): Promise<Memory> {
    const contribution = this.#contributions.get(memories, entry.type);
    if (contribution === undefined) {
      throw new Error(
        `Memory "${memoryId}" is of type "${entry.type}", which no extension contributed.`,
      );
    }
    return composeWithSecrets(
      entry,
      this.#secretStore,
      { extensionId: contribution.extensionId, location: `memories.${memoryId}` },
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
    const model = modelConfigFor(provider, blueprint.model);
    const openTask = (task: TaskModelConfig | undefined): TaskModel => {
      if (task === undefined) return { model, provider };
      const taskProvider =
        task.provider === undefined ? provider : this.#requiredProvider(task.provider);
      return { model: modelConfigFor(taskProvider, task.model), provider: taskProvider };
    };
    const compaction = openTask(blueprint.taskModels.compaction);
    const title = openTask(blueprint.taskModels.title);
    const memory =
      blueprint.memory === undefined ? undefined : this.#requiredMemory(blueprint.memory.id);

    for (const grant of [...blueprint.toolSets.direct, ...blueprint.toolSets.routed]) {
      const toolSetId = typeof grant === 'string' ? grant : grant.id;
      const problem = this.#toolSets.problem(toolSetId);
      if (problem !== undefined)
        throw new Error(`Tool set "${toolSetId}" is unavailable: ${problem}`);
    }

    const configuredDirectToolSets = await this.#toolSets.grant(blueprint.toolSets.direct);
    const routedToolSets = await this.#toolSets.grant(blueprint.toolSets.routed);
    let directToolSets = configuredDirectToolSets;
    if (blueprint.memory?.tools !== undefined) {
      if (memory?.editor === undefined) {
        throw new Error(
          `Memory "${blueprint.memory.id}" does not expose the editing surface required by its granted tools.`,
        );
      }
      directToolSets = [
        ...configuredDirectToolSets,
        memoryToolSetGrant(
          memory.editor,
          blueprint.memory.tools,
          memory.blocks,
          blueprint.memory.blocks?.map((block) => block.label),
        ),
      ];
    }
    // Fail the candidate now, rather than opening an agent whose first session
    // discovers a collision between configured and memory-owned tool names.
    composeSessionTools(directToolSets, routedToolSets, this.#authorities);

    return new Agent(this.#database, provider, model, {
      agentId,
      artifacts: this.#artifacts,
      authorities: this.#authorities,
      compactionModel: compaction.model,
      compactionProvider: compaction.provider,
      context: blueprint.context,
      directToolSets,
      gate: blueprint.gate,
      generation: blueprint.generation,
      logger: this.#logger,
      maxIterations: blueprint.maxIterations,
      ...(memory === undefined
        ? {}
        : {
            memory,
            ...(blueprint.memory?.blocks === undefined
              ? {}
              : { memoryBlocks: blueprint.memory.blocks }),
            memoryMaxTokens: blueprint.memory?.maxTokens ?? 2048,
          }),
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

  #memoryReference(memoryId: string): string | undefined {
    for (const [agentId, blueprint] of Object.entries(this.#config.get('blueprints'))) {
      if (blueprint.memory?.id === memoryId) {
        return `Agent "${agentId}" still depends on this memory.`;
      }
    }
    return undefined;
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

  #requiredMemory(memoryId: string): Memory {
    const status = this.#statuses.get(key('memory', memoryId));
    const active = this.#memories.get(memoryId);
    if (active === undefined) {
      throw new Error(
        status?.error === undefined
          ? `Memory "${memoryId}" is not configured.`
          : `Memory "${memoryId}" is unavailable: ${status.error}`,
      );
    }
    if (status?.state === 'failed') {
      throw new Error(`Memory "${memoryId}" did not activate: ${status.error ?? 'unknown error'}`);
    }
    return active.memory;
  }

  /** The provider an agent named, refused here unless it can actually hold a conversation. */
  #requiredProvider(providerId: string): ChatProvider {
    const active = this.provider(providerId);
    if (!isChatCapable(active)) {
      throw new Error(
        `Provider "${providerId}" serves no chat model, so an agent cannot talk through it. ` +
          'Name a provider that does.',
      );
    }
    return active;
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
    const configuredMemories = this.#config.get('memories');
    const configuredProviders = this.#config.get('providers');
    const configuredToolSets = this.#config.get('toolSets');
    return stableStringify({
      blueprint,
      memories:
        blueprint.memory === undefined
          ? {}
          : { [blueprint.memory.id]: configuredMemories[blueprint.memory.id] },
      providers: Object.fromEntries(providerIds.map((id) => [id, configuredProviders[id]])),
      secretRevision: this.#secretStore.revision,
      timeZone,
      toolSets: Object.fromEntries(toolSetIds.map((id) => [id, configuredToolSets[id]])),
    });
  }

  /**
   * Queues an instance for release. Most contributions hold nothing worth
   * releasing and are simply dropped; the ones that do say so by being
   * disposable.
   */
  #supersede(kind: InstanceKind, id: string, instance: unknown): void {
    if (isDisposable(instance)) this.#superseded.push({ id, instance, kind });
  }

  /**
   * Releases what nothing can reach any more, and keeps the rest for the next
   * pass. Waiting is the point: `#agentSignature` folds in the configuration of
   * the provider and memory a blueprint names, so replacing either rebuilds its
   * agents in this same pass — but a rebuild that fails keeps the agent that was
   * already running, and that agent is still holding the instance being retired.
   * Releasing it there would turn an agent that merely failed to update into one
   * that cannot answer at all, which is exactly what this runtime promises never
   * to do.
   */
  async #releaseSuperseded(generation: number): Promise<void> {
    for (const { id, instance } of this.#toolSets.takeSuperseded()) {
      this.#superseded.push({ id, instance, kind: 'toolSet' });
    }
    if (this.#superseded.length === 0) return;
    const retained: SupersededInstance[] = [];
    for (const entry of this.#superseded) {
      if (this.#stillHeld(entry.kind, entry.id, generation)) {
        retained.push(entry);
        continue;
      }
      await this.#release(entry);
    }
    this.#superseded.length = 0;
    this.#superseded.push(...retained);
  }

  async #release(entry: SupersededInstance): Promise<void> {
    try {
      await entry.instance.dispose();
    } catch (error) {
      this.#logger.error(
        { err: error, id: entry.id, kind: entry.kind },
        'A superseded component did not release cleanly.',
      );
    }
  }

  /** Whether an agent that is still answering could be holding this instance. */
  #stillHeld(kind: InstanceKind, id: string, generation: number): boolean {
    const blueprints = this.#config.get('blueprints');
    for (const agentId of this.#application.agentIds) {
      const blueprint = blueprints[agentId];
      // Serving without a blueprint means the agent was retired and kept alive
      // by a broker route. Nothing left in configuration says what it holds.
      if (blueprint === undefined) return true;
      if (!blueprintUses(blueprint, kind, id)) continue;
      const status = this.#statuses.get(key('agent', agentId));
      if (status?.state !== 'active' || status.activeGeneration !== generation) return true;
    }
    return false;
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

function modelConfigFor(provider: ChatProvider, modelId: string): ChatModelConfig {
  const configured = provider.getModelConfig(modelId);
  if (configured?.kind === 'embedding') {
    throw new Error(`Model "${modelId}" is configured for embeddings, not conversation.`);
  }
  return (
    configured ?? {
      inputModalities: ['text'] as const,
      kind: 'chat' as const,
      modelId,
      outputModalities: ['text'] as const,
    }
  );
}

export { ConfigurationRuntimeController, ConfigurationRuntimeRelay };

export type {
  ConfigurationRuntime,
  ConfigurationRuntimeOptions,
  MemoryRuntime,
  RuntimeMemorySummary,
};
