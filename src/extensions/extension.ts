import { parseExtensionManifest } from './manifest';

import type { ExtensionOrigin } from './catalog';
import type { ExtensionDefinition, ExtensionManifest } from '@nox/extension-api';

interface ExtensionLifecycleObserver {
  activated?(): void;
  activationFailed?(error: unknown): void;
}

/** A package definition bound to its validated, distribution-owned manifest. */
interface NoxExtension extends ExtensionDefinition {
  readonly manifest: ExtensionManifest;
  /**
   * Where this package came from, and therefore what it is allowed to be.
   *
   * A privilege level, not an inventory label: `builtin` ships inside the image
   * and is part of Nox, `installed` arrived afterwards and is a guest. Bound
   * here by discovery, from the directory the package was found in, so nothing
   * an extension writes can change it.
   *
   * Absent means `builtin`: the only way to arrive without one is to be handed
   * to `NoxApplication` directly, which is the host composing itself. Discovery
   * — the path a third-party package actually takes — always sets it. Read it
   * through `extensionOrigin` so the default lives in one place.
   */
  readonly origin?: ExtensionOrigin;
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
  origin: ExtensionOrigin = 'builtin',
): NoxExtension {
  return Object.freeze({
    ...definition,
    manifest: parseExtensionManifest(manifest),
    origin,
    ...(migrations === undefined ? {} : { migrations }),
    ...(observer === undefined ? {} : { observer }),
  });
}

/** Where a package came from, with the one default applied. */
function extensionOrigin(extension: NoxExtension): ExtensionOrigin {
  return extension.origin ?? 'builtin';
}

export { bindExtensionManifest, extensionOrigin };

export type { ExtensionLifecycleObserver, NoxExtension };
