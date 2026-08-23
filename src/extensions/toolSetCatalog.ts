import { composeWithSecrets, type SecretStore } from '../config/secrets';
import { type ToolSetConfig, toolSets } from './contribution-points/toolsets';

import type { ToolSetGrantConfig } from '../config/blueprint';
import type { ToolSet, ToolSetGrant } from '../tool/tool';
import type { ContributionReader } from './contribution';

interface ToolInventory {
  readonly authority: string;
  readonly description: string;
  readonly name: string;
}

interface ToolSetInventory {
  readonly available: boolean;
  readonly description?: string;
  readonly extensionId?: string;
  readonly id: string;
  readonly name?: string;
  readonly problem?: string;
  readonly tools: readonly ToolInventory[];
  readonly type: string;
}

interface ToolSetCatalogOptions {
  /**
   * Read on every call rather than captured, because the section it comes from
   * has no value until the extensions that describe it have activated — and
   * whoever holds this catalog is built before that happens.
   */
  readonly configured: () => Record<string, ToolSetConfig>;
  readonly contributions: ContributionReader;
  readonly secretStore: SecretStore;
}

/**
 * The configured tool-set instances, opened once each and shared.
 *
 * Sharing is the point rather than an optimization: two agents naming one
 * instance are talking to one service through one set of connection settings,
 * and opening it twice would make that two. It is also what forces a blueprint's
 * allowlist onto the grant — the instance is common property, so a cut stored on
 * it would be a cut for everyone.
 *
 * Instances are cached for the life of the process, which is exactly as long as
 * their configuration is guaranteed to hold: `toolsets.json` applies on restart,
 * so nothing can change what an open instance should have been.
 *
 * It exists as its own thing, rather than inside whatever composes the agents,
 * because asking what a configured tool set actually exposes is a question worth
 * answering before anything runs — a surface validating a blueprint needs the
 * same answer the agent will get, and any second way of computing it is a second
 * answer waiting to disagree.
 */
class ToolSetCatalog {
  readonly #configured: () => Record<string, ToolSetConfig>;
  readonly #contributions: ContributionReader;
  readonly #opened = new Map<string, ToolSet>();
  readonly #secretStore: SecretStore;

  constructor(options: ToolSetCatalogOptions) {
    this.#configured = options.configured;
    this.#contributions = options.contributions;
    this.#secretStore = options.secretStore;
  }

  /** Every instance `toolsets.json` configures, whether or not it has been opened. */
  public get configuredIds(): readonly string[] {
    return Object.freeze(Object.keys(this.#configured()).sort((a, b) => a.localeCompare(b)));
  }

  /**
   * Describes what every configured instance actually exposes. Factories remain
   * the authority here: configuration fields and contribution kinds cannot tell a
   * surface which tools survived instance-level enablement without rebuilding the
   * same rules a second time.
   *
   * One broken, dormant instance does not hide every other capability. Its row is
   * returned as unavailable so an operator can still repair the agents and tool
   * sets that do compose.
   */
  public async inventory(): Promise<readonly ToolSetInventory[]> {
    const configured = this.#configured();
    return Object.freeze(
      await Promise.all(
        this.configuredIds.map(async (id): Promise<ToolSetInventory> => {
          const type = configured[id]?.type ?? '';
          const extensionId = this.#contributions.get(toolSets, type)?.extensionId;
          try {
            const toolSet = await this.open(id);
            const tools = Object.values(toolSet.tools)
              .map((tool) =>
                Object.freeze({
                  authority: tool.authority,
                  description: tool.description,
                  name: tool.name,
                }),
              )
              .sort((a, b) => a.name.localeCompare(b.name));
            return Object.freeze({
              available: true,
              description: toolSet.description,
              extensionId,
              id,
              name: toolSet.name,
              tools: Object.freeze(tools),
              type,
            });
          } catch (error) {
            return Object.freeze({
              available: false,
              extensionId,
              id,
              problem: error instanceof Error ? error.message : String(error),
              tools: Object.freeze([]),
              type,
            });
          }
        }),
      ),
    );
  }

  /** Opens one configured instance, or returns the one already open. */
  public async open(toolSetId: string): Promise<ToolSet> {
    const existing = this.#opened.get(toolSetId);
    if (existing !== undefined) return existing;

    const configured = this.#configured();
    const entry = configured[toolSetId];
    if (entry === undefined) {
      const known = Object.keys(configured);
      throw new Error(
        `A blueprint names tool set "${toolSetId}", which toolsets.json does not ` +
          (known.length === 0
            ? 'configure at all.'
            : `configure. Configured: ${known.join(', ')}.`),
      );
    }

    const contribution = this.#contributions.get(toolSets, entry.type);
    if (contribution === undefined) {
      throw new Error(
        `Tool set "${toolSetId}" is of type "${entry.type}", which no extension contributed.`,
      );
    }

    const toolSet = await composeWithSecrets(
      entry,
      this.#secretStore,
      { extensionId: contribution.extensionId, location: `toolSets.${toolSetId}` },
      (config) => contribution.value.create(config),
    );
    this.#opened.set(toolSetId, toolSet);

    return toolSet;
  }

  /**
   * One blueprint's list of grants, opened and normalized. The bare string and
   * the object form name the same instance; only the object form also says how
   * much of it this agent gets.
   */
  public async grant(entries: readonly ToolSetGrantConfig[]): Promise<ToolSetGrant[]> {
    const grants: ToolSetGrant[] = [];
    const seen = new Set<string>();

    for (const requested of entries) {
      const toolSetId = typeof requested === 'string' ? requested : requested.id;
      const tools = typeof requested === 'string' ? undefined : requested.tools;

      if (seen.has(toolSetId)) {
        throw new Error(`Tool set "${toolSetId}" is granted more than once in one blueprint list.`);
      }
      seen.add(toolSetId);

      grants.push(Object.freeze({ toolSet: await this.open(toolSetId), toolSetId, tools }));
    }

    return grants;
  }
}

export { ToolSetCatalog };

export type { ToolInventory, ToolSetCatalogOptions, ToolSetInventory };
