import { composeSessionTools } from '../../agent/tools';

import type { AuthorityCatalog } from '../../auth/authority';
import type { Blueprint, ToolSetGrantConfig } from '../../config/blueprint';
import type { Config } from '../../config/config';
import type { ToolSetCatalog } from '../../extensions/toolSetCatalog';

/**
 * A blueprint that would not survive the restart it asks for. Saving one is how
 * a surface bricks an installation politely: the file passes its own schema,
 * the write succeeds, and the next boot — or the next session — fails naming
 * something the operator has to read a log to find.
 */
class BlueprintReferenceError extends Error {
  public readonly problems: readonly string[];

  constructor(agentId: string, problems: readonly string[]) {
    super(`Blueprint "${agentId}" cannot be saved: ${problems.join('; ')}.`);
    this.name = 'BlueprintReferenceError';
    this.problems = Object.freeze([...problems]);
  }
}

/** What the blueprint checks need that no blueprint document contains. */
interface BlueprintContext {
  /**
   * Read per call, not captured: the catalog is assembled from what extensions
   * contributed, and the store is built before they have activated.
   */
  readonly authorities: () => AuthorityCatalog;
  readonly config: Config;
  readonly toolSets: ToolSetCatalog;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
}

/** The instance ID out of either form a tool-set grant may take. */
function grantId(grant: ToolSetGrantConfig): string {
  return typeof grant === 'string' ? grant : grant.id;
}

/**
 * Everything one blueprint asks of the rest of the installation, checked before
 * it is written: that the providers it names exist, and that the tool sets it
 * grants actually compose into a table an agent can run on.
 *
 * The second is answered by opening the tool sets and running the very function
 * a session runs — not a copy of its rules kept here, which is the only way the
 * answer stays the same as the session's.
 */
async function assertBlueprintReferences(
  agentId: string,
  blueprint: Blueprint,
  context: BlueprintContext,
): Promise<void> {
  const configured = context.config.get('providers');
  const problems: string[] = [];

  const referenced = [
    blueprint.provider,
    blueprint.taskModels.compaction?.provider,
    blueprint.taskModels.title?.provider,
  ];
  for (const provider of referenced) {
    if (provider !== undefined && !Object.hasOwn(configured, provider)) {
      problems.push(`providers.json configures no provider "${provider}"`);
    }
  }

  if (problems.length > 0) throw new BlueprintReferenceError(agentId, problems);

  try {
    const direct = await context.toolSets.grant(blueprint.toolSets.direct);
    const routed = await context.toolSets.grant(blueprint.toolSets.routed);

    composeSessionTools(direct, routed, context.authorities());
  } catch (error) {
    throw new BlueprintReferenceError(agentId, [reason(error)]);
  }
}

/**
 * Why this agent cannot be removed, if it cannot. Bootstrap refuses to compose a
 * Nox with no agent at all, and refuses one whose configured default agent no
 * blueprint defines — so both are answered here, where the operator is still
 * looking at the change that caused it, rather than at a restart they may not
 * perform until much later.
 */
function blueprintRemovalReasons(config: Config, agentId: string): readonly string[] {
  const reasons: string[] = [];

  if (Object.keys(config.get('blueprints')).length === 1) {
    reasons.push('Nox composes no agent from an empty blueprints directory.');
  }
  if (config.get('app').chat.defaultAgent === agentId) {
    reasons.push(`Web chat names "${agentId}" as its default agent; change app.json first.`);
  }

  return reasons;
}

/**
 * Why this configured instance cannot be removed, if it cannot: the blueprints
 * that name it. Same failure as a blueprint that cannot be saved, seen from the
 * other side — the file that would break is not the one being written.
 */
function instanceRemovalReasons(
  config: Config,
  key: 'providers' | 'toolSets',
  instanceId: string,
): readonly string[] {
  return Object.entries(config.get('blueprints'))
    .filter(([, blueprint]) => names(blueprint, key, instanceId))
    .map(([agentId]) => `blueprints/${agentId}.json names it.`)
    .sort((a, b) => a.localeCompare(b));
}

function names(blueprint: Blueprint, key: 'providers' | 'toolSets', instanceId: string): boolean {
  if (key === 'providers') {
    return [
      blueprint.provider,
      blueprint.taskModels.compaction?.provider,
      blueprint.taskModels.title?.provider,
    ].includes(instanceId);
  }
  return [...blueprint.toolSets.direct, ...blueprint.toolSets.routed]
    .map(grantId)
    .includes(instanceId);
}

export {
  assertBlueprintReferences,
  BlueprintReferenceError,
  blueprintRemovalReasons,
  instanceRemovalReasons,
};

export type { BlueprintContext };
