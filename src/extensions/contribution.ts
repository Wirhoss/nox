import { assertDiscriminator, assertIdentifier, isConfigurable } from '@nox/extension-api';

import { toDisposable } from './disposable';
import { DuplicateContributionError } from './error';

import type {
  Contribution,
  ContributionDescriptor,
  ContributionPoint,
  ContributionReader,
  Disposable,
  DisposableRegistry,
  ExtensionContributions,
} from '@nox/extension-api';

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

  public ownedBy(extensionId: string): readonly ContributionDescriptor[] {
    return Object.freeze(
      [...this.#points.entries()]
        .flatMap(([point, contributions]) =>
          [...contributions.values()]
            .filter((contribution) => contribution.extensionId === extensionId)
            .map(({ id }) => Object.freeze({ id, point })),
        )
        .sort((left, right) => {
          const byPoint = left.point.localeCompare(right.point);
          return byPoint === 0 ? left.id.localeCompare(right.id) : byPoint;
        }),
    );
  }

  /** Creates a view that attributes every registration to one extension. */
  public scoped(extensionId: string, resources: DisposableRegistry): ExtensionContributions {
    return Object.freeze({
      get: <T>(point: ContributionPoint<T>, contributionId: string): Contribution<T> | undefined =>
        this.get(point, contributionId),
      has: <T>(point: ContributionPoint<T>, contributionId: string): boolean =>
        this.has(point, contributionId),
      list: <T>(point: ContributionPoint<T>): readonly Contribution<T>[] => this.list(point),
      ownedBy: (extensionIdToRead: string): readonly ContributionDescriptor[] =>
        this.ownedBy(extensionIdToRead),
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

export { ContributionRegistry };
