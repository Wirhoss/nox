import { composeSessionTools } from '../../agent/tools';

import type { AuthorityCatalog } from '../../auth/authority';
import type { Blueprint } from '../../config/blueprint';
import type { Config, ConfigUpdate } from '../../config/config';
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

interface BlueprintStoreOptions {
  /**
   * Read per call, not captured: the catalog is assembled from what extensions
   * contributed, and this store is built before they have activated.
   */
  readonly authorities: () => AuthorityCatalog;
  readonly config: Config;
  readonly toolSets: ToolSetCatalog;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
}

/**
 * The blueprints as something a surface can administer: read them, write one,
 * remove one. It is a view over `Config` rather than a second home for them —
 * the files on disk stay the only copy, and a blueprint written here is a
 * blueprint the loader would have accepted from an editor.
 *
 * What it adds is the judgement a blueprint's own schema cannot pass, because it
 * is about the rest of the installation rather than about the document: whether
 * the providers exist, and whether these grants actually compose into a tool
 * table an agent can run on. The second one is answered by opening the tool sets
 * and running the very function a session runs — not by a copy of its rules
 * kept here, which is the only way the answer stays the same as the session's.
 */
class BlueprintStore {
  readonly #authorities: () => AuthorityCatalog;
  readonly #config: Config;
  readonly #toolSets: ToolSetCatalog;

  constructor(options: BlueprintStoreOptions) {
    this.#authorities = options.authorities;
    this.#config = options.config;
    this.#toolSets = options.toolSets;
  }

  /** The agent a new web conversation uses, when the installation names one. */
  public get defaultAgent(): string | undefined {
    return this.#config.get('app').chat.defaultAgent;
  }

  public list(): Readonly<Record<string, Blueprint>> {
    return this.#config.get('blueprints');
  }

  public read(agentId: string): Blueprint | undefined {
    return this.list()[agentId];
  }

  /**
   * Validates and writes one blueprint. Everything is checked between parsing
   * and writing, inside the lock that serializes configuration writes, so a
   * blueprint that fails leaves no file and no half-applied change behind.
   */
  public async save(agentId: string, source: unknown): Promise<ConfigUpdate<Blueprint>> {
    return this.#config.updateEntry('blueprints', agentId, source, async (blueprint) => {
      this.#assertProviders(agentId, blueprint);
      await this.#assertComposable(agentId, blueprint);
    });
  }

  public async remove(agentId: string): Promise<boolean> {
    return this.#config.removeEntry('blueprints', agentId);
  }

  #assertProviders(agentId: string, blueprint: Blueprint): void {
    const configured = this.#config.get('providers');
    const problems: string[] = [];

    for (const provider of [blueprint.provider, blueprint.compaction?.provider]) {
      if (provider !== undefined && !Object.hasOwn(configured, provider)) {
        problems.push(`providers.json configures no provider "${provider}"`);
      }
    }

    if (problems.length > 0) throw new BlueprintReferenceError(agentId, problems);
  }

  /**
   * Opens the tool sets this blueprint grants and composes them exactly as a
   * session would. Anything a session would refuse — a set nothing configures,
   * a set that cannot be built, a named tool it does not expose, two sets
   * answering to one tool name — is refused here instead, where the operator is
   * still looking at the change that caused it.
   */
  async #assertComposable(agentId: string, blueprint: Blueprint): Promise<void> {
    try {
      const direct = await this.#toolSets.grant(blueprint.toolSets.direct);
      const routed = await this.#toolSets.grant(blueprint.toolSets.routed);

      composeSessionTools(direct, routed, this.#authorities());
    } catch (error) {
      throw new BlueprintReferenceError(agentId, [reason(error)]);
    }
  }
}

export { BlueprintReferenceError, BlueprintStore };

export type { BlueprintStoreOptions };
