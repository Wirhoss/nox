import { z } from 'zod';

import { connectBroker } from './broker';
import { connectMemory } from './memory';
import { RemoteToolSet } from './toolSet';

import type { ActivationPlan, CrossedContribution } from './activation';
import type { ExtensionProcess } from './host';
import type { ContributionDeclaration, ExtensionManifest } from '@nox/extension-api';

/**
 * One installed extension, activated inside its confined process.
 *
 * What comes back from activation is a list of contributions as documents. This
 * turns each one back into something the host's registry can hold: a real
 * `ConfigurableContribution`, with a real Zod schema, whose `create` builds an
 * instance on the far side and hands back a proxy.
 */

/**
 * The contribution points whose instances can live on the far side.
 *
 * `nox.providers` is the one missing, and it is missing loudly: an installed
 * package that contributes one is refused when it activates, by name, rather
 * than working until the first model call. Providers stream, and streaming is
 * its own crossing.
 *
 * Points whose values are already data — authorities, language packs,
 * translations — are not here because they need no instance at all. They cross
 * as themselves.
 */
const INSTANTIABLE_POINTS = new Set(['nox.brokers', 'nox.memories', 'nox.toolsets']);

let nextHandle = 0;

/** A configured contribution as the host holds it, once rebuilt. */
interface CrossedConfigurable {
  readonly configSchema: z.ZodObject<{ type: z.ZodLiteral<string> }>;
  readonly instances: ContributionDeclaration['instances'];
  create(config: unknown): Promise<unknown>;
}

interface ConfinedContribution {
  readonly id: string;
  readonly point: string;
  readonly value: unknown;
}

/**
 * Rebuilds the contribution's schema on this side.
 *
 * The child sent JSON Schema and `z.fromJSONSchema` turns it back into a Zod
 * object, which is what the config loader validates an operator's file with.
 * The round trip is faithful for everything JSON Schema can express — types,
 * constraints, defaults, the discriminating literal — and lossy for exactly one
 * thing: a `refine`, which has no notation there.
 *
 * That loss is why the child validates again before it builds anything. A
 * custom check still runs; it just reports when the instance is created rather
 * than when the file is read. Loose here and strict there is the safe direction
 * of that trade — the reverse would reject configurations the extension
 * accepts.
 */
function rebuildSchema(declaration: ContributionDeclaration): CrossedConfigurable['configSchema'] {
  return z.fromJSONSchema(declaration.schema) as CrossedConfigurable['configSchema'];
}

/**
 * Turns what the child reported into what the host's registry holds.
 *
 * A point whose values are already data — an authority's description, a
 * language pack — crosses as itself. A configurable one crosses as its
 * declaration plus a `create` that reaches back.
 */
function rebuild(
  process: ExtensionProcess,
  extensionId: string,
  crossed: CrossedContribution,
): ConfinedContribution {
  if (crossed.declaration === undefined) {
    return { id: crossed.id, point: crossed.point, value: crossed.value };
  }
  if (!INSTANTIABLE_POINTS.has(crossed.point)) {
    throw new TypeError(
      `Extension "${extensionId}" contributes "${crossed.id}" to "${crossed.point}", which ` +
        'cannot cross into a confined process yet. Installed extensions run confined; this one ' +
        'cannot be loaded until that contribution point crosses.',
    );
  }
  const declaration = crossed.declaration;
  const value: CrossedConfigurable = {
    configSchema: rebuildSchema(declaration),
    create: async (config: unknown): Promise<unknown> => {
      const handle = `${extensionId}#${String(++nextHandle)}`;
      await process.invoke('activation.create', crossed.point, crossed.id, handle, config);
      return await proxyFor(process, crossed.point, handle);
    },
    instances: declaration.instances,
  };
  return { id: crossed.id, point: crossed.point, value };
}

/**
 * The host-side object for one instance living in the child.
 *
 * Each is the proxy that contract already has, handed a channel addressed to
 * this instance — so none of them had to learn that an extension can contribute
 * more than one thing.
 */
async function proxyFor(
  process: ExtensionProcess,
  point: string,
  handle: string,
): Promise<unknown> {
  const channel = process.scoped(handle);
  switch (point) {
    case 'nox.brokers':
      return await connectBroker({ brokerId: handle, channel });
    case 'nox.memories':
      return await connectMemory(channel);
    case 'nox.toolsets':
      return await RemoteToolSet.connect(channel);
    default:
      throw new TypeError(`Contributions to "${point}" cannot cross a process boundary yet.`);
  }
}

/**
 * Activates one extension in its process and reports what it contributed.
 *
 * The manifest crosses because an extension reads its own — its id, its
 * version, what it declared. The declared service list crosses with it, because
 * the child enforces the same rule the host does: a package reaches only what
 * it named, and the refusal happens where the `get` happens.
 */
async function activateConfined(
  process: ExtensionProcess,
  manifest: ExtensionManifest,
): Promise<readonly ConfinedContribution[]> {
  const plan: ActivationPlan = { manifest, services: manifest.services ?? [] };
  await process.invoke('activation.activate', plan);
  const crossed = (await process.invoke(
    'activation.contributions',
  )) as readonly CrossedContribution[];
  return crossed.map((entry) => rebuild(process, manifest.id, entry));
}

export { activateConfined };
export type { ConfinedContribution, CrossedConfigurable };
