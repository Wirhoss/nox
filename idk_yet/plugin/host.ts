import { satisfies, valid } from "semver";

import { DisposableStore, type Disposable } from "./disposable.ts";
import {
  CircularPluginDependencyError,
  DuplicatePluginError,
  MissingPluginDependencyError,
  PluginActivationError,
  PluginCompatibilityError,
  PluginDeactivationError,
  PluginDependencyVersionError,
  UnknownPluginError,
} from "./errors.ts";
import { ExtensionRegistry, type ExtensionReader } from "./extension.ts";
import { noopLogger, prefixLogger, type Logger } from "./logger.ts";
import { parsePluginManifest, type PluginManifest } from "./manifest.ts";
import type { NoxPlugin, PluginContext } from "./plugin.ts";
import {
  ServiceCollection,
  type ServiceContainer,
  type ServiceToken,
} from "./service.ts";

export const NOX_VERSION = "0.1.0";

export type PluginState =
  | "registered"
  | "activating"
  | "active"
  | "deactivating"
  | "inactive"
  | "failed";

export interface PluginStatus {
  readonly id: string;
  readonly version: string;
  readonly state: PluginState;
  readonly error?: unknown;
}

export interface PluginFailure {
  readonly pluginId: string;
  readonly error: unknown;
}

export interface PluginActivationReport {
  readonly activated: readonly string[];
  readonly failed: readonly PluginFailure[];
}

export interface PluginDeactivationReport {
  readonly deactivated: readonly string[];
  readonly failed: readonly PluginFailure[];
}

export interface PluginHostOptions {
  readonly noxVersion?: string;
  readonly logger?: Logger;
  /** Injected by NoxApplication so one application owns the service state. */
  readonly services?: ServiceCollection;
}

interface PluginRecord {
  readonly plugin: NoxPlugin;
  readonly manifest: PluginManifest;
  state: PluginState;
  error?: unknown;
  resources?: DisposableStore;
  abortController?: AbortController;
}

export class PluginHost {
  readonly #records = new Map<string, PluginRecord>();
  readonly #activationOrder: string[] = [];
  readonly #extensionRegistry = new ExtensionRegistry();
  readonly #services: ServiceCollection;
  readonly #serviceReader: ServiceContainer;
  readonly #logger: Logger;
  readonly #noxVersion: string;

  public constructor(options: PluginHostOptions = {}) {
    this.#logger = options.logger ?? noopLogger;
    this.#services = options.services ?? new ServiceCollection();
    this.#serviceReader = Object.freeze({
      has: <T>(token: ServiceToken<T>): boolean => this.#services.has(token),
      get: <T>(token: ServiceToken<T>): T => this.#services.get(token),
      tryGet: <T>(token: ServiceToken<T>): T | undefined => this.#services.tryGet(token),
    });
    this.#noxVersion = options.noxVersion ?? NOX_VERSION;
    if (valid(this.#noxVersion) === null) {
      throw new TypeError(`Invalid Nox semantic version "${this.#noxVersion}".`);
    }
  }

  public get extensions(): ExtensionReader {
    return this.#extensionRegistry;
  }

  public provideService<T>(token: ServiceToken<T>, service: T): this {
    this.#services.provide(token, service);
    return this;
  }

  public register(plugin: NoxPlugin): this {
    const manifest = parsePluginManifest(plugin.manifest);
    if (this.#records.has(manifest.id)) {
      throw new DuplicatePluginError(manifest.id);
    }
    if (!satisfies(this.#noxVersion, manifest.engines.nox, { includePrerelease: true })) {
      throw new PluginCompatibilityError(
        `Plugin "${manifest.id}" requires Nox ${manifest.engines.nox}, current version is ${this.#noxVersion}.`,
        manifest.id,
      );
    }

    const validatedPlugin: NoxPlugin = Object.freeze({ ...plugin, manifest });
    this.#records.set(manifest.id, {
      plugin: validatedPlugin,
      manifest,
      state: "registered",
    });
    return this;
  }

  public getStatus(pluginId: string): PluginStatus | undefined {
    const record = this.#records.get(pluginId);
    if (!record) return undefined;
    return Object.freeze({
      id: record.manifest.id,
      version: record.manifest.version,
      state: record.state,
      error: record.error,
    });
  }

  public listStatuses(): readonly PluginStatus[] {
    return [...this.#records.keys()].map((pluginId) => this.getStatus(pluginId)!);
  }

  public async activate(pluginId: string): Promise<void> {
    this.#services.lock();
    await this.#activate(pluginId, []);
  }

  /** Activates every registered plugin while allowing unrelated plugins to survive failures. */
  public async activateAll(): Promise<PluginActivationReport> {
    this.#services.lock();
    const activeBefore = new Set(
      [...this.#records].filter(([, record]) => record.state === "active").map(([id]) => id),
    );

    for (const pluginId of this.#records.keys()) {
      try {
        await this.#activate(pluginId, []);
      } catch {
        // The record retains the failure. Continue in degraded mode.
      }
    }

    const activated = this.#activationOrder.filter((id) => !activeBefore.has(id));
    const failed = [...this.#records]
      .filter(([, record]) => record.state === "failed")
      .map(([id, record]) => Object.freeze({ pluginId: id, error: record.error }));

    return Object.freeze({ activated, failed });
  }

  /** Deactivates active dependents first, then the requested plugin. */
  public async deactivate(pluginId: string): Promise<void> {
    this.#requireRecord(pluginId);
    await this.#deactivateWithDependents(pluginId, new Set());
  }

  public async deactivateAll(): Promise<PluginDeactivationReport> {
    const deactivated: string[] = [];
    const failed: PluginFailure[] = [];

    for (const pluginId of [...this.#activationOrder].reverse()) {
      const record = this.#records.get(pluginId);
      if (record?.state !== "active") continue;
      try {
        await this.#deactivateOne(record);
        deactivated.push(pluginId);
      } catch (error) {
        failed.push(Object.freeze({ pluginId, error }));
      }
    }

    return Object.freeze({ deactivated, failed });
  }

  public async unregister(pluginId: string): Promise<void> {
    this.#requireRecord(pluginId);
    await this.deactivate(pluginId);
    this.#records.delete(pluginId);
  }

  async #activate(pluginId: string, trail: readonly string[]): Promise<void> {
    const record = this.#requireRecord(pluginId);
    if (record.state === "active") return;
    if (record.state === "activating") {
      const start = trail.indexOf(pluginId);
      const path = [...(start >= 0 ? trail.slice(start) : trail), pluginId];
      throw new CircularPluginDependencyError(path);
    }
    if (record.state === "deactivating") {
      throw new PluginActivationError(pluginId, new Error("Plugin is currently deactivating."));
    }

    record.state = "activating";
    record.error = undefined;
    const nextTrail = [...trail, pluginId];

    try {
      for (const [dependencyId, range] of Object.entries(record.manifest.dependencies ?? {})) {
        const dependency = this.#records.get(dependencyId);
        if (!dependency) throw new MissingPluginDependencyError(pluginId, dependencyId);
        this.#assertDependencyVersion(pluginId, dependency, range);
        await this.#activate(dependencyId, nextTrail);
      }

      for (const [dependencyId, range] of Object.entries(
        record.manifest.optionalDependencies ?? {},
      )) {
        const dependency = this.#records.get(dependencyId);
        if (!dependency) continue;
        try {
          this.#assertDependencyVersion(pluginId, dependency, range);
          await this.#activate(dependencyId, nextTrail);
        } catch (error) {
          this.#logger.warn(`Optional dependency "${dependencyId}" is unavailable.`, {
            pluginId,
            error,
          });
        }
      }

      const resources = new DisposableStore();
      const abortController = new AbortController();
      const context: PluginContext = Object.freeze({
        plugin: record.manifest,
        logger: prefixLogger(this.#logger, pluginId),
        signal: abortController.signal,
        services: this.#serviceReader,
        extensions: this.#extensionRegistry.scoped(pluginId, resources),
        subscriptions: Object.freeze({
          add: <T extends Disposable>(resource: T): T => resources.add(resource),
        }),
      });

      try {
        const activationResource = await record.plugin.activate(context);
        if (activationResource) resources.add(activationResource);
      } catch (activationError) {
        abortController.abort(activationError);
        try {
          await resources.dispose();
        } catch (disposalError) {
          throw new AggregateError(
            [activationError, disposalError],
            `Plugin "${pluginId}" failed during activation and rollback.`,
          );
        }
        throw activationError;
      }

      record.resources = resources;
      record.abortController = abortController;
      record.state = "active";
      this.#activationOrder.push(pluginId);
      this.#logger.info(`Plugin "${pluginId}" activated.`);
    } catch (cause) {
      const error = new PluginActivationError(pluginId, cause);
      record.resources = undefined;
      record.abortController = undefined;
      record.state = "failed";
      record.error = error;
      this.#logger.error(`Plugin "${pluginId}" failed to activate.`, { error });
      throw error;
    }
  }

  async #deactivateWithDependents(pluginId: string, visited: Set<string>): Promise<void> {
    if (visited.has(pluginId)) return;
    visited.add(pluginId);

    for (const [candidateId, candidate] of this.#records) {
      if (candidate.state !== "active" || !this.#dependsOn(candidate, pluginId)) continue;
      await this.#deactivateWithDependents(candidateId, visited);
    }

    const record = this.#requireRecord(pluginId);
    if (record.state === "active") await this.#deactivateOne(record);
  }

  async #deactivateOne(record: PluginRecord): Promise<void> {
    const pluginId = record.manifest.id;
    record.state = "deactivating";
    const errors: unknown[] = [];
    record.abortController?.abort(new Error(`Plugin "${pluginId}" is deactivating.`));

    try {
      await record.plugin.deactivate?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await record.resources?.dispose();
    } catch (error) {
      errors.push(error);
    }

    record.resources = undefined;
    record.abortController = undefined;
    record.state = "inactive";
    record.error = undefined;
    const orderIndex = this.#activationOrder.lastIndexOf(pluginId);
    if (orderIndex >= 0) this.#activationOrder.splice(orderIndex, 1);

    if (errors.length > 0) {
      const error = new PluginDeactivationError(
        pluginId,
        new AggregateError(errors, `Plugin "${pluginId}" did not deactivate cleanly.`),
      );
      record.error = error;
      this.#logger.error(`Plugin "${pluginId}" failed to deactivate cleanly.`, { error });
      throw error;
    }
    this.#logger.info(`Plugin "${pluginId}" deactivated.`);
  }

  #assertDependencyVersion(pluginId: string, dependency: PluginRecord, range: string): void {
    if (!satisfies(dependency.manifest.version, range, { includePrerelease: true })) {
      throw new PluginDependencyVersionError(
        pluginId,
        dependency.manifest.id,
        range,
        dependency.manifest.version,
      );
    }
  }

  #dependsOn(record: PluginRecord, pluginId: string): boolean {
    return (
      Object.hasOwn(record.manifest.dependencies ?? {}, pluginId) ||
      Object.hasOwn(record.manifest.optionalDependencies ?? {}, pluginId)
    );
  }

  #requireRecord(pluginId: string): PluginRecord {
    const record = this.#records.get(pluginId);
    if (!record) throw new UnknownPluginError(pluginId);
    return record;
  }
}
