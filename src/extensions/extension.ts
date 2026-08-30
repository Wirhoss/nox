import { parseExtensionManifest } from './manifest';

import type { ExtensionDefinition, ExtensionManifest } from '@nox/extension-api';

interface ExtensionLifecycleObserver {
  activated?(): void;
  activationFailed?(error: unknown): void;
}

/** A package definition bound to its validated, distribution-owned manifest. */
interface NoxExtension extends ExtensionDefinition {
  readonly manifest: ExtensionManifest;
  /**
   * Absolute directory of the migrations the manifest declared, once discovery
   * has resolved it against the package and confirmed it stayed inside.
   */
  readonly migrations?: string;
  /** Host-only lifecycle reporting used by discovered packages. */
  readonly observer?: ExtensionLifecycleObserver;
}

/** @internal Attaches package identity after discovery; extension code cannot replace it. */
function bindExtensionManifest(
  manifest: ExtensionManifest,
  definition: ExtensionDefinition,
  observer?: ExtensionLifecycleObserver,
  migrations?: string,
): NoxExtension {
  return Object.freeze({
    ...definition,
    manifest: parseExtensionManifest(manifest),
    ...(migrations === undefined ? {} : { migrations }),
    ...(observer === undefined ? {} : { observer }),
  });
}

export { bindExtensionManifest };

export type { ExtensionLifecycleObserver, NoxExtension };
