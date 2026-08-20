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

import type { ExtensionContext, NoxExtension } from './extensions/extension';

type ApplicationState = 'created' | 'running' | 'starting' | 'stopped' | 'stopping';

interface NoxApplicationOptions {
  logger?: Logger;
  noxVersion?: string;
  extensions?: Iterable<NoxExtension>;
}

class NoxApplication {
  readonly #abortController = new AbortController();
  readonly #contributions = new ContributionRegistry();
  readonly #logger: Logger;
  readonly #noxVersion: string;
  readonly #extensions = new Map<string, NoxExtension>();
  readonly #resources = new DisposableStore();
  readonly #services = new ServiceCollection();

  #state: ApplicationState = 'created';

  constructor(options: NoxApplicationOptions = {}) {
    this.#logger = options.logger ?? silentLogger;
    this.#noxVersion = options.noxVersion ?? NOX_VERSION;
    assertVersion(this.#noxVersion, 'Nox version');

    for (const extension of options.extensions ?? []) {
      this.register(extension);
    }
  }

  public get contributions(): ContributionReader {
    return this.#contributions;
  }

  public get services(): ServiceContainer {
    return this.#services;
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
}

export { NoxApplication };

export type { ApplicationState, NoxApplicationOptions };
