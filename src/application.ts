import { type ContributionReader, ContributionRegistry } from './extensions/contribution';
import { type Disposable, DisposableStore } from './extensions/disposable';
import {
  DuplicateExtensionError,
  ExtensionActivationError,
  ExtensionCompatibilityError,
} from './extensions/error';
import { assertVersion, type ExtensionManifest, isCompatible } from './extensions/manifest';
import { ServiceCollection, type ServiceContainer, type ServiceToken } from './extensions/service';
import { type Logger, silentLogger } from './logger/logger';
import { NOX_VERSION } from './version';

import type { Agent, OpenSessionOptions } from './agent/agent';
import type { Session } from './agent/session';
import type { ExtensionContext, NoxExtension } from './extensions/extension';

type ApplicationState = 'created' | 'running' | 'starting' | 'stopped' | 'stopping';

interface NoxApplicationOptions {
  logger?: Logger;
  noxVersion?: string;
  extensions?: Iterable<NoxExtension>;
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
  readonly #agents = new Map<string, Agent>();
  readonly #contributions = new ContributionRegistry();
  readonly #logger: Logger;
  readonly #noxVersion: string;
  readonly #extensions = new Map<string, NoxExtension>();
  readonly #resources = new DisposableStore();
  readonly #services = new ServiceCollection();
  readonly #sessions = new Map<string, LiveSession>();

  #state: ApplicationState = 'created';

  constructor(options: NoxApplicationOptions = {}) {
    this.#logger = options.logger ?? silentLogger;
    this.#noxVersion = options.noxVersion ?? NOX_VERSION;
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
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      throw new Error(`Cannot add an agent while Nox is ${this.#state}.`);
    }
    // The agent names itself, because its sessions are stored under that name.
    // A registry key of its own could disagree with what the transcripts say.
    const { agentId } = agent;
    if (this.#agents.has(agentId)) {
      throw new Error(`An agent is already registered as ${agentId}.`);
    }
    this.#agents.set(agentId, agent);
    return this;
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
      // Conversations end first: they are still using the provider an extension
      // contributed and the storage this shutdown is about to close.
      for (const { session } of [...this.#sessions.values()].reverse()) {
        await this.#close(session);
      }
      this.#sessions.clear();

      for (const extension of [...this.#extensions.values()].reverse()) {
        await this.#deactivate(extension);
      }
      await this.#resources.dispose();
    } finally {
      this.#state = 'stopped';
    }
  }

  async #activate(extension: NoxExtension): Promise<void> {
    const { id } = extension.manifest;
    const resources = this.#resources.add(new DisposableStore());

    const context: ExtensionContext = Object.freeze({
      contributions: this.#contributions.scoped(id, resources),
      logger: this.#logger.child(id),
      extension: extension.manifest,
      services: this.#services,
      signal: this.#abortController.signal,
      subscriptions: Object.freeze({
        add: <T extends Disposable>(resource: T): T => resources.add(resource),
      }),
    });

    try {
      await extension.activate(context);
    } catch (error) {
      throw new ExtensionActivationError(id, error);
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
