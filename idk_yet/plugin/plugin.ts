import type { Disposable, DisposableRegistry } from "./disposable.ts";
import type { PluginExtensions } from "./extension.ts";
import type { Logger } from "./logger.ts";
import type { PluginManifest } from "./manifest.ts";
import { parsePluginManifest } from "./manifest.ts";
import type { ServiceContainer } from "./service.ts";

export type MaybePromise<T> = T | PromiseLike<T>;

export interface PluginContext {
  readonly plugin: PluginManifest;
  readonly logger: Logger;
  /** Aborted before plugin cleanup starts. */
  readonly signal: AbortSignal;
  readonly services: ServiceContainer;
  readonly extensions: PluginExtensions;
  readonly subscriptions: DisposableRegistry;
}

export interface NoxPlugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): MaybePromise<void | Disposable>;
  deactivate?(): MaybePromise<void>;
}

/** Validates a plugin at its declaration site while preserving its concrete type. */
export function definePlugin<const T extends NoxPlugin>(plugin: T): T {
  return Object.freeze({
    ...plugin,
    manifest: parsePluginManifest(plugin.manifest),
  }) as T;
}
