import { ContributionRegistry } from './extensions/contribution';
import { DisposableStore } from './extensions/disposable';
import {
  DuplicateExtensionError,
  ExtensionActivationError,
  ExtensionCompatibilityError,
} from './extensions/error';
import { assertVersion, isCompatible } from './extensions/manifest';
import { ServiceCollection } from './extensions/service';
import { MemoryExtensionStorageProvider } from './extensions/storage';
import { silentLogger } from './logger/logger';
import { NOX_VERSION } from './version';

import type { Agent, OpenSessionOptions } from './agent/agent';
import type { Session } from './agent/session';
import type { NoxExtension } from './extensions/extension';
import type { ExtensionStorageProvider } from './extensions/storage';
import type { MessageGateway } from './gateway/gateway';
import type { Logger } from './logger/logger';
import type {
  ContributionReader,
  Disposable,
  ExtensionContext,
  ExtensionManifest,
  ServiceContainer,
  ServiceToken,
} from '@nox/extension-api';

type ApplicationState = 'created' | 'running' | 'starting' | 'stopped' | 'stopping';

interface NoxApplicationOptions {
  extensions?: Iterable<NoxExtension>;
  logger?: Logger;
  noxVersion?: string;
  storage?: ExtensionStorageProvider;
}

/** A conversation that is still alive, and the agent it is being held with. */
interface LiveSession {
  readonly agentId: string;
  readonly session: Session;
}

/**
 * The running Nox: the extensions it has activated, the services they were
 * handed, the agents that can be talked to and the sessions currently talking.
 *
 * It composes nothing. Whatever names a concrete provider, store or extension
 * hands the result here — which is what keeps every law about what the kernel
 * may import a property of the import graph rather than a review note.
 */
class NoxApplication {
  readonly #abortController = new AbortController();
  readonly #activatedExtensions = new Set<string>();
  readonly #agents = new Map<string, Agent>();
  readonly #contributions = new ContributionRegistry();
  readonly #logger: Logger;
  readonly #noxVersion: string;
  readonly #extensions = new Map<string, NoxExtension>();
  readonly #resources = new DisposableStore();
  readonly #services = new ServiceCollection();
  readonly #sessions = new Map<string, LiveSession>();
  readonly #storage: ExtensionStorageProvider;

  #gateway?: MessageGateway;
  #state: ApplicationState = 'created';

  constructor(options: NoxApplicationOptions = {}) {
    this.#logger = options.logger ?? silentLogger;
    this.#noxVersion = options.noxVersion ?? NOX_VERSION;
    this.#storage = options.storage ?? new MemoryExtensionStorageProvider();
    assertVersion(this.#noxVersion, 'Nox version');

    for (const extension of options.extensions ?? []) {
      this.register(extension);
    }
  }

  public get agentIds(): readonly string[] {
    return Object.freeze([...this.#agents.keys()].sort((a, b) => a.localeCompare(b)));
  }

  public get contributions(): ContributionReader {
    return this.#contributions;
  }

  public get services(): ServiceContainer {
    return this.#services;
  }

  /**
   * The sessions still alive. A session stopped through its own handle rather
   * than through `closeSession` drops out here too, so the answer to "what is
   * running" is never a list of things that already finished.
   */
  public get sessions(): readonly LiveSession[] {
    for (const [sessionId, live] of this.#sessions) {
      if (live.session.state === 'stopped') this.#sessions.delete(sessionId);
    }
    return Object.freeze([...this.#sessions.values()]);
  }

  /**
   * Whether any live session is inside a run.
   *
   * The same sweep `sessions` does, asked as a yes or no. It is a scan rather
   * than a counter kept at run boundaries because the count would have to be
   * decremented by every path a run can end on — including the ones that end it
   * by abandoning the session — and a counter that drifts upward would tell a
   * background extension the machine is busy forever.
   */
  public busy(): boolean {
    return this.sessions.some((live) => live.session.state === 'running');
  }

  public get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  public get noxVersion(): string {
    return this.#noxVersion;
  }

  public get state(): ApplicationState {
    return this.#state;
  }

  public getAgent(agentId: string): Agent | undefined {
    return this.#agents.get(agentId);
  }

  /**
   * Agents may join a Nox that is already running: authoring one is something a
   * surface does, not something a restart does. Extensions and services are not
   * like that — an extension already activated would see the set move.
   */
  public addAgent(agent: Agent): this {
    if (this.#agents.has(agent.agentId)) {
      throw new Error(`An agent is already registered as ${agent.agentId}.`);
    }
    return this.replaceAgent(agent);
  }

  /**
   * Atomically publishes a new generation for future sessions. Existing sessions
   * keep their immutable snapshot until the gateway retires them after their
   * current turn.
   */
  public replaceAgent(agent: Agent): this {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      throw new Error(`Cannot replace an agent while Nox is ${this.#state}.`);
    }
    this.#agents.set(agent.agentId, agent);
    return this;
  }

  /** Removes the route for future sessions; already-open snapshots remain valid. */
  public removeAgent(agentId: string): boolean {
    if (this.#state === 'stopped' || this.#state === 'stopping') return false;
    return this.#agents.delete(agentId);
  }

  /**
   * Hands the application a resource to release once every extension is down.
   * Storage passed to extensions as a service is what this exists for: they were
   * given it, so they let go of it before it closes.
   */
  public own<T extends Disposable>(resource: T): T {
    this.#assertConfigurable('take ownership of resources');
    return this.#resources.add(resource);
  }

  /**
   * The message gateway, if this Nox has one. It is held apart from the
   * resources `own` takes because shutdown order is the whole point: transports
   * go quiet first, and only then are the sessions they were feeding closed.
   * Anything else would let a message arrive for a conversation being torn down.
   */
  public setGateway(gateway: MessageGateway): this {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      throw new Error(`Cannot set the gateway while Nox is ${this.#state}.`);
    }
    if (this.#gateway !== undefined) {
      throw new Error('A message gateway is already set.');
    }
    this.#gateway = gateway;
    return this;
  }

  public provide<T>(token: ServiceToken<T>, service: T): this {
    this.#assertConfigurable('provide services');
    this.#services.provide(token, service);
    return this;
  }

  public register(extension: NoxExtension): this {
    this.#assertConfigurable('register extensions');
    const { id } = extension.manifest;
    if (this.#extensions.has(id)) {
      throw new DuplicateExtensionError(id);
    }
    this.#extensions.set(id, extension);
    return this;
  }

  /** Opens a session with a registered agent and holds it until it stops. */
  public async openSession(agentId: string, options: OpenSessionOptions = {}): Promise<Session> {
    this.#assertRunning('open a session');
    const agent = this.#agents.get(agentId);
    if (agent === undefined) {
      throw new Error(`No agent is registered as ${agentId}.`);
    }

    const session = await agent.openSession(options);

    // Opening reaches storage, so a shutdown may have begun in the meantime. A
    // session nothing will ever close is worse than one that never opened.
    if (this.#state !== 'running') {
      await session.stop();
      this.#assertRunning('open a session');
    }

    this.#sessions.set(session.sessionId, Object.freeze({ agentId, session }));
    return session;
  }

  /** Stops a live session and drops it. False when nothing was holding it. */
  public async closeSession(sessionId: string): Promise<boolean> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return false;

    this.#sessions.delete(sessionId);
    await live.session.stop();
    return true;
  }

  public async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new Error(`Nox cannot start while it is ${this.#state}.`);
    }
    this.#state = 'starting';
    this.#services.lock();

    for (const extension of this.#extensions.values()) {
      this.#assertCompatible(extension.manifest);
    }

    for (const extension of this.#extensions.values()) {
      await this.#activate(extension);
    }

    this.#state = 'running';
  }

  public async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') return;
    this.#state = 'stopping';
    this.#abortController.abort();

    try {
      // Nothing new may arrive while conversations are being closed, so the
      // transports stop before the sessions they deliver into.
      await this.#stopGateway();

      // Conversations end first: they are still using the provider an extension
      // contributed and the storage this shutdown is about to close.
      for (const { session } of [...this.#sessions.values()].reverse()) {
        await this.#close(session);
      }
      this.#sessions.clear();

      for (const extension of [...this.#extensions.values()].reverse()) {
        if (this.#activatedExtensions.has(extension.manifest.id)) await this.#deactivate(extension);
      }
      this.#activatedExtensions.clear();
      await this.#resources.dispose();
      // Last: an extension released above may have written on its way out.
      await this.#storage.close();
    } finally {
      this.#state = 'stopped';
    }
  }

  async #activate(extension: NoxExtension): Promise<void> {
    const { id } = extension.manifest;
    const resources = this.#resources.add(new DisposableStore());

    try {
      // Inside the guard because opening the extension's storage view applies
      // the migrations it ships, and a schema that will not apply is a failure
      // to activate rather than a different kind of problem.
      const context: ExtensionContext = Object.freeze({
        contributions: this.#contributions.scoped(id, resources),
        logger: this.#logger.child(id),
        extension: extension.manifest,
        services: this.#services,
        signal: this.#abortController.signal,
        storage: await this.#storage.forExtension({
          extensionId: id,
          ...(extension.migrations === undefined ? {} : { migrations: extension.migrations }),
        }),
        subscriptions: Object.freeze({
          add: <T extends Disposable>(resource: T): T => resources.add(resource),
        }),
      });
      await extension.activate(context);
      this.#activatedExtensions.add(id);
      extension.observer?.activated?.();
    } catch (error) {
      try {
        await resources.dispose();
      } catch (disposeError) {
        this.#logger.error(
          { err: disposeError, extensionId: id },
          'Failed extension resources did not dispose cleanly.',
        );
      }
      if (extension.observer?.activationFailed !== undefined) {
        extension.observer.activationFailed(error);
        return;
      }
      throw new ExtensionActivationError(id, error);
    }
  }

  async #stopGateway(): Promise<void> {
    if (this.#gateway === undefined) return;
    try {
      await this.#gateway.stop();
    } catch (error) {
      this.#logger.error({ err: error }, 'The message gateway failed to stop cleanly.');
    }
  }

  async #close(session: Session): Promise<void> {
    try {
      await session.stop();
    } catch (error) {
      this.#logger.error(
        { err: error, sessionId: session.sessionId },
        'Session failed to stop cleanly.',
      );
    }
  }

  async #deactivate(extension: NoxExtension): Promise<void> {
    if (extension.deactivate === undefined) return;
    try {
      await extension.deactivate();
    } catch (error) {
      this.#logger.error(
        { err: error, extensionId: extension.manifest.id },
        'Extension failed to deactivate cleanly.',
      );
    }
  }

  #assertCompatible(manifest: ExtensionManifest): void {
    if (!isCompatible(manifest, this.#noxVersion)) {
      throw new ExtensionCompatibilityError(manifest.id, manifest.engines.nox, this.#noxVersion);
    }
  }

  #assertConfigurable(action: string): void {
    if (this.#state !== 'created') {
      throw new Error(`Cannot ${action} while Nox is ${this.#state}.`);
    }
  }

  #assertRunning(action: string): void {
    if (this.#state !== 'running') {
      throw new Error(`Nox cannot ${action} while it is ${this.#state}.`);
    }
  }
}

export { NoxApplication };

export type { ApplicationState, LiveSession, NoxApplicationOptions };
