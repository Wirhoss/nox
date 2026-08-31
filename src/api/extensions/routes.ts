import { EXTENSION_API_VERSION } from '@nox/extension-api';
import { Elysia } from 'elysia';

import { authGuard } from '../auth/guard';

import type { ExtensionCatalog } from '../../extensions/catalog';
import type { AuthStore } from '../auth/store';
import type { ContributionReader } from '@nox/extension-api';

interface ExtensionRoutesOptions {
  readonly catalog: ExtensionCatalog;
  readonly contributions: ContributionReader;
  readonly store: AuthStore;
}

/** Authenticated inventory; loading code and absolute package paths never cross the API. */
function createExtensionRoutes(options: ExtensionRoutesOptions) {
  return new Elysia({ name: 'nox.api.extensions.routes' }).use(authGuard(options.store)).get(
    '/extensions',
    () => ({
      extensionApiVersion: EXTENSION_API_VERSION,
      extensions: options.catalog.list(options.contributions),
    }),
    { authenticated: true },
  );
}

function extensionRoutes(
  options: ExtensionRoutesOptions,
): ReturnType<typeof createExtensionRoutes> {
  return createExtensionRoutes(options);
}

export { extensionRoutes };

export type { ExtensionRoutesOptions };
