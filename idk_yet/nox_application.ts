import {
  DisposableStore,
  type Disposable,
  type DisposableRegistry,
} from "./plugin/disposable.ts";
import {
  PluginHost,
  type PluginActivationReport,
  type PluginDeactivationReport,
} from "./plugin/host.ts";
import type { Logger } from "./plugin/logger.ts";
import type { NoxPlugin } from "./plugin/plugin.ts";
import { ServiceCollection, type ServiceToken } from "./plugin/service.ts";

export type ApplicationState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface NoxApplicationOptions {
  readonly logger?: Logger;
  readonly noxVersion?: string;
  readonly plugins?: Iterable<NoxPlugin>;
}

/**
 * Composition root and sole owner of one Nox runtime's mutable object graph.
 * Subsystems retain their own responsibilities, but none of them are global.
 */
export class NoxApplication {
  public readonly services: ServiceCollection;
  public readonly plugins: PluginHost;
  public readonly subscriptions: DisposableRegistry;

  readonly #resources = new DisposableStore();
  readonly #abortController = new AbortController();

  #state: ApplicationState = "created";
  #activationReport?: PluginActivationReport;
  #startOperation?: Promise<PluginActivationReport>;
  #stopOperation?: Promise<PluginDeactivationReport>;

  public constructor(options: NoxApplicationOptions = {}) {
    this.services = new ServiceCollection();
    this.plugins = new PluginHost({
      logger: options.logger,
      noxVersion: options.noxVersion,
      services: this.services,
    });
    this.subscriptions = Object.freeze({
      add: <T extends Disposable>(resource: T): T => this.#resources.add(resource),
    });

    for (const plugin of options.plugins ?? []) {
      this.plugins.register(plugin);
    }
  }

  public get state(): ApplicationState {
    return this.#state;
  }

  /** Global cancellation signal for sessions, jobs, gateways and other app-owned work. */
  public get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  public get activationReport(): PluginActivationReport | undefined {
    return this.#activationReport;
  }

  public registerPlugin(plugin: NoxPlugin): this {
    this.#assertConfigurable("register plugins");
    this.plugins.register(plugin);
    return this;
  }

  public provideService<T>(token: ServiceToken<T>, service: T): this {
    this.#assertConfigurable("provide services");
    this.services.provide(token, service);
    return this;
  }

  /** Adds an application-owned resource that must outlive plugins. */
  public own<T extends Disposable>(resource: T): T {
    if (this.#state === "stopping" || this.#state === "stopped" || this.#state === "failed") {
      throw new Error(`Cannot own new resources while Nox is ${this.#state}.`);
    }
    return this.#resources.add(resource);
  }

  public start(): Promise<PluginActivationReport> {
    if (this.#state === "running") return Promise.resolve(this.#activationReport!);
    if (this.#startOperation) return this.#startOperation;
    if (this.#state !== "created") {
      return Promise.reject(new Error(`Cannot start Nox while it is ${this.#state}.`));
    }

    this.#state = "starting";
    this.#startOperation = this.#performStart();
    return this.#startOperation;
  }

  public stop(): Promise<PluginDeactivationReport> {
    this.#stopOperation ??= this.#performStop();
    return this.#stopOperation;
  }

  async #performStart(): Promise<PluginActivationReport> {
    try {
      const report = await this.plugins.activateAll();
      this.#activationReport = report;
      this.#state = "running";
      return report;
    } catch (error) {
      this.#state = "failed";
      this.#abortController.abort(error);
      const cleanupErrors: unknown[] = [error];

      const pluginCleanup = await this.plugins.deactivateAll();
      cleanupErrors.push(...pluginCleanup.failed.map((failure) => failure.error));
      try {
        await this.#resources.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      throw cleanupErrors.length === 1
        ? error
        : new AggregateError(cleanupErrors, "Nox failed to start and clean up.");
    }
  }

  async #performStop(): Promise<PluginDeactivationReport> {
    if (this.#state === "starting") {
      try {
        await this.#startOperation;
      } catch {
        // Startup already recorded its failure and performed rollback.
      }
    }

    if (this.#state === "stopped") {
      return Object.freeze({ deactivated: [], failed: [] });
    }

    this.#state = "stopping";
    this.#abortController.abort(new Error("Nox is stopping."));

    const report = await this.plugins.deactivateAll();
    let resourceError: unknown;
    try {
      await this.#resources.dispose();
    } catch (error) {
      resourceError = error;
    } finally {
      this.#state = "stopped";
    }

    if (resourceError !== undefined) throw resourceError;
    return report;
  }

  #assertConfigurable(action: string): void {
    if (this.#state !== "created") {
      throw new Error(`Cannot ${action} while Nox is ${this.#state}.`);
    }
  }
}
