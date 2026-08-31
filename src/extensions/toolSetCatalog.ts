import { isDisposable, toolSets } from '@nox/extension-api';

import { composeWithSecrets } from '../config/secrets';
import { stableStringify } from '../utils/json';

import type { ToolSetGrantConfig } from '../config/blueprint';
import type { SecretStore } from '../config/secrets';
import type {
  ContributionReader,
  Disposable,
  ToolSet,
  ToolSetConfig,
  ToolSetGrant,
  ToolSetInventory,
} from '@nox/extension-api';

/** One instance the catalog has replaced or dropped, for its owner to release. */
interface SupersededToolSet {
  readonly id: string;
  readonly instance: Disposable;
}

interface ToolSetCatalogOptions {
  /**
   * Read on every call rather than captured, because the section it comes from
   * has no value until the extensions that describe it have activated — and
   * whoever holds this catalog is built before that happens.
   */
  readonly configured: () => Record<string, ToolSetConfig>;
  readonly contributions: ContributionReader;
  /** Runtime inputs captured by factories but not present in one configured entry. */
  readonly runtimeSignature?: () => unknown;
  readonly secretStore: SecretStore;
}

/**
 * The configured tool-set instances, opened once each and shared. Sharing is the
 * point rather than an optimization: two agents naming one instance are talking
 * to one service through one set of connection settings — and it is what forces
 * a blueprint's allowlist onto the grant, since a cut stored on the instance
 * would be a cut for everyone.
 *
 * Instances are cached by desired-configuration signature: a changed entry is
 * built beside its previous generation and replaces it only after construction
 * succeeds, so sessions already holding the old object stay consistent. The
 * catalog exists on its own rather than inside whatever composes the agents,
 * because a surface validating a blueprint must get the same answer the agent
 * will get, and any second way of computing it is a second answer waiting to
 * disagree.
 */
class ToolSetCatalog {
  readonly #configured: () => Record<string, ToolSetConfig>;
  readonly #contributions: ContributionReader;
  readonly #opened = new Map<string, { readonly signature: string; readonly toolSet: ToolSet }>();
  readonly #problems = new Map<string, string>();
  readonly #runtimeSignature?: () => unknown;
  readonly #secretStore: SecretStore;
  readonly #superseded: SupersededToolSet[] = [];

  constructor(options: ToolSetCatalogOptions) {
    this.#configured = options.configured;
    this.#contributions = options.contributions;
    this.#runtimeSignature = options.runtimeSignature;
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

  /** Last failure to activate the desired configuration of one instance. */
  public problem(toolSetId: string): string | undefined {
    return this.#problems.get(toolSetId);
  }

  /**
   * Reconciles every configured instance independently. A broken replacement
   * leaves its previous object alive for sessions that already use it and does
   * not prevent unrelated tool sets from activating.
   */
  public async refresh(): Promise<void> {
    const configuredIds = new Set(this.configuredIds);
    await Promise.all(
      [...configuredIds].map(async (toolSetId) => {
        try {
          await this.open(toolSetId);
        } catch {
          // `open` recorded the actionable problem; one entry never hides peers.
        }
      }),
    );
    for (const [toolSetId, open] of this.#opened) {
      if (configuredIds.has(toolSetId)) continue;
      this.#opened.delete(toolSetId);
      this.#supersede(toolSetId, open.toolSet);
    }
    for (const toolSetId of this.#problems.keys()) {
      if (!configuredIds.has(toolSetId)) this.#problems.delete(toolSetId);
    }
  }

  /**
   * Hands over the instances this catalog has replaced or dropped, and forgets
   * them.
   *
   * The catalog does not release them itself because it cannot know when it is
   * safe to: an instance it replaced is still inside every agent that was
   * granted it, and only whoever rebuilds agents knows whether that has
   * happened. Deliberately kept out of here — this catalog answers what a
   * configured tool set exposes, and knowing about agents would make it a
   * second, disagreeing account of how they are composed.
   */
  public takeSuperseded(): readonly SupersededToolSet[] {
    return this.#superseded.splice(0, this.#superseded.length);
  }

  /** Moves every open instance into the superseded queue, for a shutting-down owner. */
  public retire(): void {
    for (const [toolSetId, open] of this.#opened) this.#supersede(toolSetId, open.toolSet);
    this.#opened.clear();
  }

  /** Opens the desired instance, retaining but never returning stale state after a failed change. */
  public async open(toolSetId: string): Promise<ToolSet> {
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

    const signature = stableStringify({
      entry,
      runtime: this.#runtimeSignature?.(),
      secretRevision: this.#secretStore.revision,
    });
    const existing = this.#opened.get(toolSetId);
    if (existing?.signature === signature) return existing.toolSet;

    const contribution = this.#contributions.get(toolSets, entry.type);
    if (contribution === undefined) {
      throw new Error(
        `Tool set "${toolSetId}" is of type "${entry.type}", which no extension contributed.`,
      );
    }

    try {
      const toolSet = await composeWithSecrets(
        entry,
        this.#secretStore,
        { extensionId: contribution.extensionId, location: `toolSets.${toolSetId}` },
        (config) => contribution.value.create(config),
      );
      this.#opened.set(toolSetId, { signature, toolSet });
      if (existing !== undefined) this.#supersede(toolSetId, existing.toolSet);
      this.#problems.delete(toolSetId);
      return toolSet;
    } catch (error) {
      this.#problems.set(toolSetId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Most tool sets hold nothing that outlives a garbage collection; the ones
   * that do — a spawned process, an open connection — say so by being
   * disposable.
   */
  #supersede(toolSetId: string, toolSet: ToolSet): void {
    if (isDisposable(toolSet)) this.#superseded.push({ id: toolSetId, instance: toolSet });
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

export type { ToolSetCatalogOptions };
