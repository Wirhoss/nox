import { z } from 'zod';

/**
 * One capability a principal can be granted, named once and owned by exactly one
 * extension. Authorities are a catalog rather than free strings so that a typo in
 * a grant is a load failure instead of a permission that silently never matches —
 * and so that two extensions cannot quietly claim the same name.
 *
 * The trust boundary is worth stating: installed extensions run code and are part
 * of the TCB. Namespacing prevents collisions and accidental laundering of a
 * name; it does not sandbox a hostile extension, and is not meant to.
 */
interface AuthorityDefinition {
  readonly description: string;
  readonly id: string;
  readonly ownerExtensionId: string;
}

/** Segments are lowercase and dotted, and there is always more than one. */
const AUTHORITY_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

const authorityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(
    AUTHORITY_PATTERN,
    'Use dot-separated lowercase segments, for example "nox.core.history.read".',
  );

const authorityDefinitionSchema = z.object({
  description: z.string().trim().min(1),
  id: authorityIdSchema,
  ownerExtensionId: z.string().trim().min(1),
});

/**
 * Everything the core owns. It is not an extension, so it names itself — and it
 * names itself narrowly.
 *
 * `nox.core` rather than `nox`, so the core lives under the same rule as
 * everybody else: it may register `nox.core.*` and nothing more. The wider
 * `nox.` stays a namespace nobody owns, holding the core beside the builtins
 * — `nox.toolset.web`, `nox.broker.discord` — instead of over them.
 *
 * That separation is what makes `nox.core.*` a grant worth writing. Before it,
 * the only pattern covering the core's own authorities was `nox.*`, which also
 * covered every builtin's, so "give this agent what the core offers, and
 * nothing else" could not be said. It also removes a collision that was waiting:
 * the core's topics and the builtins' categories shared one segment, and a
 * builtin one day named `nox.memory` would have owned `nox.memory.*` — the
 * core's own memory authorities included.
 */
const CORE_OWNER_ID = 'nox.core';

/**
 * The namespace an owner may register under. Extension IDs are package-like and
 * may be scoped (`@acme/tools`); authority IDs are dotted, so a scoped ID becomes
 * one — `@acme/tools` owns `acme.tools.*`. Builtin IDs already begin with `nox.`,
 * which is how `nox.*` stays reserved for the core and its builtins without a
 * second rule saying so.
 */
function ownerNamespace(extensionId: string): string {
  return extensionId.replace(/^@/, '').replaceAll('/', '.');
}

/** True when `prefix` covers `id` on a segment boundary, never mid-segment. */
function isNamespaceOf(prefix: string, id: string): boolean {
  return id.startsWith(`${prefix}.`);
}

/**
 * A grant entry. `*` and `namespace.*` are deliberately dynamic: whoever writes
 * one is accepting the authorities that namespace gains later, which is the point
 * of asking for a namespace rather than a list. An explicit list stays closed.
 */
type GrantPattern = string;

function isWildcard(pattern: GrantPattern): boolean {
  return pattern === '*' || pattern.endsWith('.*');
}

/** The namespace a `namespace.*` pattern covers. */
function wildcardPrefix(pattern: GrantPattern): string {
  return pattern.slice(0, -2);
}

function matchesPattern(pattern: GrantPattern, authorityId: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return isNamespaceOf(wildcardPrefix(pattern), authorityId);
  return pattern === authorityId;
}

class UnknownAuthorityError extends Error {
  public readonly authorityId: string;

  constructor(authorityId: string, context: string) {
    super(`${context} references authority "${authorityId}", which nothing registered.`);
    this.name = 'UnknownAuthorityError';
    this.authorityId = authorityId;
  }
}

/**
 * The authorities this Nox knows about, assembled once at startup from the core's
 * own list and whatever the activated extensions contributed. Everything that
 * names an authority — a tool, a grant, a wildcard — is checked against it, and a
 * name nobody registered is a configuration error rather than a silent deny.
 */
class AuthorityCatalog {
  readonly #byId: ReadonlyMap<string, AuthorityDefinition>;

  private constructor(byId: ReadonlyMap<string, AuthorityDefinition>) {
    this.#byId = byId;
  }

  /**
   * Validates the whole catalog at once: shape, ownership and uniqueness. It
   * throws rather than dropping an entry, because a catalog missing an authority
   * is a Nox where some tool can never be authorized and nobody is told why.
   */
  public static from(definitions: readonly AuthorityDefinition[]): AuthorityCatalog {
    const byId = new Map<string, AuthorityDefinition>();

    for (const source of definitions) {
      const parsed = authorityDefinitionSchema.safeParse(source);
      if (!parsed.success) {
        throw new TypeError(
          `Invalid authority "${source.id}" from ${source.ownerExtensionId}: ` +
            (parsed.error.issues[0]?.message ?? 'it does not describe an authority.'),
        );
      }

      const definition = parsed.data;
      const namespace = ownerNamespace(definition.ownerExtensionId);
      if (!isNamespaceOf(namespace, definition.id)) {
        throw new TypeError(
          `Extension "${definition.ownerExtensionId}" cannot own authority "${definition.id}": ` +
            `it may only register authorities under "${namespace}.".`,
        );
      }

      const existing = byId.get(definition.id);
      if (existing !== undefined) {
        throw new TypeError(
          `Authority "${definition.id}" is registered by both ` +
            `"${existing.ownerExtensionId}" and "${definition.ownerExtensionId}".`,
        );
      }
      byId.set(definition.id, Object.freeze({ ...definition }));
    }

    return new AuthorityCatalog(byId);
  }

  public get ids(): readonly string[] {
    return Object.freeze([...this.#byId.keys()].sort((a, b) => a.localeCompare(b)));
  }

  public get(authorityId: string): AuthorityDefinition | undefined {
    return this.#byId.get(authorityId);
  }

  public has(authorityId: string): boolean {
    return this.#byId.has(authorityId);
  }

  public assertKnown(authorityId: string, context: string): void {
    if (!this.#byId.has(authorityId)) {
      throw new UnknownAuthorityError(authorityId, context);
    }
  }

  /**
   * Checks a grant entry without freezing what it will cover. An exact name has
   * to exist now; a wildcard only has to name a namespace that exists now, and
   * keeps covering whatever is added under it later.
   */
  public assertGrantPattern(pattern: GrantPattern, context: string): void {
    if (pattern === '*') return;

    if (isWildcard(pattern)) {
      const prefix = wildcardPrefix(pattern);
      const known = [...this.#byId.keys()].some((id) => isNamespaceOf(prefix, id));
      if (!known) {
        throw new TypeError(
          `${context} grants "${pattern}", but no registered authority lives under ` +
            `"${prefix}.".`,
        );
      }
      return;
    }

    this.assertKnown(pattern, context);
  }

  /** Whether any of these grant entries covers the authority. */
  public covers(patterns: readonly GrantPattern[], authorityId: string): string | undefined {
    return patterns.find((pattern) => matchesPattern(pattern, authorityId));
  }
}

export {
  AuthorityCatalog,
  authorityDefinitionSchema,
  authorityIdSchema,
  CORE_OWNER_ID,
  isWildcard,
  matchesPattern,
  ownerNamespace,
  UnknownAuthorityError,
};

export type { AuthorityDefinition, GrantPattern };
