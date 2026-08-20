import { type ExtensionManifest, parseExtensionManifest } from './manifest';

import type { Logger } from '../logger/logger';
import type { ExtensionContributions } from './contribution';
import type { DisposableRegistry } from './disposable';
import type { ServiceContainer } from './service';

type MaybePromise<T> = PromiseLike<T> | T;

/** Everything a contribution is handed. It imports nothing concrete itself. */
interface ExtensionContext {
  readonly contributions: ExtensionContributions;
  readonly logger: Logger;
  readonly extension: ExtensionManifest;
  readonly services: ServiceContainer;
  /** Aborted before extension cleanup starts. */
  readonly signal: AbortSignal;
  readonly subscriptions: DisposableRegistry;
}

interface NoxExtension {
  readonly manifest: ExtensionManifest;
  /**
   * Resources are owned through `context.subscriptions`, never by returning
   * them: anything added there is tracked from the moment it is acquired, so a
   * extension that fails halfway through activation still releases what it took.
   */
  activate(context: ExtensionContext): MaybePromise<void>;
  deactivate?(): MaybePromise<void>;
}

/** Validates an extension at its declaration site while preserving its concrete type. */
function defineExtension<const T extends NoxExtension>(extension: T): T {
  return Object.freeze({ ...extension, manifest: parseExtensionManifest(extension.manifest) });
}

export { defineExtension };

export type { ExtensionContext, MaybePromise, NoxExtension };
