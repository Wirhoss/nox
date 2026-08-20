import { type Disposable, type DisposableRegistry, toDisposable } from './disposable';
import { DuplicateContributionError } from './error';
import { assertIdentifier } from './identifier';

declare const contributionType: unique symbol;

interface ContributionPoint<T> {
  readonly id: string;
  readonly [contributionType]?: (value: T) => T;
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

export { ContributionRegistry, createContributionPoint };

export type { Contribution, ContributionPoint, ContributionReader, ExtensionContributions };
