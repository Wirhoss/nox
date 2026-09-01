import { dirname } from 'node:path';

import { activateConfined } from './extension';
import { ExtensionProcess } from './host';

import type { Logger } from '../../logger/logger';
import type { Allowance } from '../confinement';
import type { ExtensionContext, ExtensionManifest } from '@nox/extension-api';

interface ConfinedExtensionOptions {
  /** Absolute path to the module the child imports, once confined. */
  readonly entryPoint: string;
  readonly logger: Logger;
  readonly manifest: ExtensionManifest;
  /**
   * Run the child without confinement on a kernel that has none. The
   * operator's deliberate choice, never a fallback — see `unconfinableReason`.
   */
  readonly runUnconfined?: boolean;
}

/**
 * What a confined extension is allowed to reach on disk.
 *
 * Its own directory, so it can import itself and whatever it ships. The
 * runtime's directories, so Bun can start and resolve the host packages it
 * declared. Nothing writable but `/dev`, because nothing it can be given today
 * writes: extension storage does not cross the boundary yet, and a writable
 * directory handed over before anything needs one is a permission granted for
 * no reason.
 *
 * Deliberately not `DATA_DIR`. That is where the database, the secret key and
 * every other extension's storage live, and no filesystem declaration will ever
 * be allowed to name it.
 */
function allowancesFor(entryPoint: string): readonly Allowance[] {
  return [
    { path: '/usr', write: false },
    { path: '/lib', write: false },
    { path: '/lib64', write: false },
    { path: '/bin', write: false },
    { path: '/etc', write: false },
    { path: '/app', write: false },
    { path: '/proc', write: false },
    { path: '/sys', write: false },
    { path: dirname(entryPoint), write: false },
    { path: '/dev', write: true },
  ];
}

/**
 * An installed extension, as the rest of Nox sees it.
 *
 * This is the whole of the loader change, and it is small on purpose: a
 * confined extension is an `ExtensionDefinition` whose `activate` happens to
 * start a process. Everything `NoxApplication` already does — ordering,
 * disposal, reporting a failed activation to the catalog, tearing down in
 * reverse — works unchanged, because nothing about it was ever specific to
 * running the package in this process.
 *
 * What arrives from the far side is registered into the host's own registry,
 * through the same scoped view a builtin gets. So a confined contribution
 * passes the same guards: the discriminator has to match its ID, and it still
 * cannot default a field to a secret reference.
 */
function confinedExtension(options: ConfinedExtensionOptions): {
  activate(context: ExtensionContext): Promise<void>;
  deactivate(): Promise<void>;
} {
  let process: ExtensionProcess | undefined;

  return {
    activate: async (context: ExtensionContext): Promise<void> => {
      const started = new ExtensionProcess({
        allowances: allowancesFor(options.entryPoint),
        extensionId: options.manifest.id,
        logger: options.logger,
        ...(options.runUnconfined === true ? { runUnconfined: true } : {}),
      });
      process = started;
      // Registered before anything can throw, so a package that fails halfway
      // through activation still takes its process with it.
      context.subscriptions.add({
        dispose: async () => {
          await started.dispose();
        },
      });

      await started.load(options.entryPoint);
      for (const contributed of await activateConfined(started, options.manifest)) {
        context.contributions.register(
          { id: contributed.point },
          contributed.id,
          contributed.value,
        );
      }
    },
    deactivate: async (): Promise<void> => {
      const started = process;
      process = undefined;
      if (started === undefined) return;
      // Asked first, killed second: a transport mid-delivery is worth a bounded
      // moment, and `dispose` is what bounds it.
      try {
        await started.invoke('activation.deactivate');
      } catch (error) {
        options.logger.warn(
          { err: error, extensionId: options.manifest.id },
          'A confined extension did not deactivate cleanly; its process is being stopped anyway.',
        );
      }
      await started.dispose();
    },
  };
}

export { allowancesFor, confinedExtension };
export type { ConfinedExtensionOptions };
