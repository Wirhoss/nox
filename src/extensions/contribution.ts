import { z } from 'zod';

import { type Disposable, type DisposableRegistry, toDisposable } from './disposable';
import { DuplicateContributionError } from './error';
import { assertIdentifier } from './identifier';

import type { ResolvedSecrets } from '../config/secrets';

declare const contributionType: unique symbol;

/**
 * The phantom field carries `T` for inference and keeps the brand nominal. It is
 * declared as a value rather than a function so the type stays covariant: a
 * point for a specific contribution has to be readable as a point for an unknown
 * one, which is how anything generic over points — the configuration module
 * above all — can hold one without knowing what fills it.
 */
interface ContributionPoint<T> {
  readonly id: string;
  readonly [contributionType]?: T;
}

/**
 * The shape every contributed configuration schema must have: an object whose
 * `type` literal is the contribution's own ID. The discriminator is what lets one
 * configuration file hold many configured instances of many kinds and still
 * resolve each entry to the contribution that has to validate and build it.
 */
type ContributionConfigSchema = z.ZodObject<{ type: z.ZodLiteral<string> }>;

/**
 * A contribution built from configuration. The schema is a readable field, never
 * a closure: the configuration module has to enumerate the schemas of everything
 * registered in order to validate a file whose shape it has never seen. A
 * contribution that hides its schema inside `create` can only be configured by
 * the code that wrote it, which is no configuration at all.
 */
interface ConfigurableContribution<TSchema extends ContributionConfigSchema, TValue> {
  readonly configSchema: TSchema;
  /**
   * Config has already been validated, and every credential it named has been
   * replaced by an opaque handle. A contribution reads a secret only where its
   * own schema declared one, because that is the only place a reference could
   * have survived validation.
   */
  create(config: ResolvedSecrets<z.infer<TSchema>>): TValue;
}

/** The erased view the configuration module reads. */
type UnknownConfigurable = ConfigurableContribution<ContributionConfigSchema, unknown>;

function isConfigurable(value: unknown): value is UnknownConfigurable {
  if (typeof value !== 'object' || value === null || !('configSchema' in value)) return false;
  return value.configSchema instanceof z.ZodObject;
}

/**
 * The discriminator has to equal the contribution ID, because an entry names its
 * kind by `type` while the registry finds that kind by ID. Letting the two
 * disagree produces a file that validates and still resolves to nothing.
 */
function assertDiscriminator(value: UnknownConfigurable, contributionId: string): void {
  const discriminator: unknown = value.configSchema.shape.type;
  if (!(discriminator instanceof z.ZodLiteral)) {
    throw new TypeError(
      `Contribution "${contributionId}" has a configSchema without a "type" literal.`,
    );
  }
  if (discriminator.value !== contributionId) {
    throw new TypeError(
      `Contribution "${contributionId}" declares config type "${String(discriminator.value)}"; ` +
        'the discriminator and the contribution ID must be the same.',
    );
  }
}

interface Contribution<T> {
  readonly id: string;
  readonly extensionId: string;
  readonly value: T;
}

interface ContributionReader {
  get<T>(point: ContributionPoint<T>, contributionId: string): Contribution<T> | undefined;
  has<T>(point: ContributionPoint<T>, contributionId: string): boolean;
  list<T>(point: ContributionPoint<T>): readonly Contribution<T>[];
}

/** What an extension receives: the same reads, plus writes attributed to itself. */
interface ExtensionContributions extends ContributionReader {
  register<T>(point: ContributionPoint<T>, contributionId: string, value: T): Disposable;
}

function createContributionPoint<T>(id: string): ContributionPoint<T> {
  assertIdentifier(id, 'contribution point ID');
  return Object.freeze({ id });
}

type UnknownContribution = Contribution<unknown>;

/** Internal storage. Extensions receive an owner-scoped view instead. */
class ContributionRegistry implements ContributionReader {
  readonly #points = new Map<string, Map<string, UnknownContribution>>();

  public get<T>(point: ContributionPoint<T>, contributionId: string): Contribution<T> | undefined {
    return this.#points.get(point.id)?.get(contributionId) as Contribution<T> | undefined;
  }

  public has<T>(point: ContributionPoint<T>, contributionId: string): boolean {
    return this.#points.get(point.id)?.has(contributionId) ?? false;
  }

  public list<T>(point: ContributionPoint<T>): readonly Contribution<T>[] {
    return Object.freeze([...(this.#points.get(point.id)?.values() ?? [])] as Contribution<T>[]);
  }

  /** Creates a view that attributes every registration to one extension. */
  public scoped(extensionId: string, resources: DisposableRegistry): ExtensionContributions {
    return Object.freeze({
      get: <T>(point: ContributionPoint<T>, contributionId: string): Contribution<T> | undefined =>
        this.get(point, contributionId),
      has: <T>(point: ContributionPoint<T>, contributionId: string): boolean =>
        this.has(point, contributionId),
      list: <T>(point: ContributionPoint<T>): readonly Contribution<T>[] => this.list(point),
      register: <T>(point: ContributionPoint<T>, contributionId: string, value: T): Disposable => {
        assertIdentifier(contributionId, 'contribution ID');
        if (isConfigurable(value)) assertDiscriminator(value, contributionId);
        return resources.add(this.#register(extensionId, point, contributionId, value));
      },
    });
  }

  #register<T>(
    extensionId: string,
    point: ContributionPoint<T>,
    contributionId: string,
    value: T,
  ): Disposable {
    let contributions = this.#points.get(point.id);
    if (contributions === undefined) {
      contributions = new Map();
      this.#points.set(point.id, contributions);
    }
    if (contributions.has(contributionId)) {
      throw new DuplicateContributionError(extensionId, point.id, contributionId);
    }

    const contribution = Object.freeze({ id: contributionId, extensionId, value });
    contributions.set(contributionId, contribution);

    return toDisposable(() => {
      // A re-registration after disposal owns the slot; never evict someone else.
      if (contributions.get(contributionId) !== contribution) return;
      contributions.delete(contributionId);
      if (contributions.size === 0) this.#points.delete(point.id);
    });
  }
}

export { ContributionRegistry, createContributionPoint, isConfigurable };

export type {
  ConfigurableContribution,
  Contribution,
  ContributionConfigSchema,
  ContributionPoint,
  ContributionReader,
  ExtensionContributions,
  UnknownConfigurable,
};
