import type { DisposableStore, Disposable } from "./disposable.ts";
import { toDisposable } from "./disposable.ts";
import { DuplicateContributionError } from "./errors.ts";
import { assertIdentifier } from "./manifest.ts";

declare const extensionType: unique symbol;

export interface ExtensionPoint<T> {
  readonly id: string;
  readonly [extensionType]?: (value: T) => T;
}

export interface ExtensionContribution<T> {
  readonly id: string;
  readonly pluginId: string;
  readonly value: T;
}

export interface ExtensionReader {
  has<T>(point: ExtensionPoint<T>, contributionId: string): boolean;
  get<T>(point: ExtensionPoint<T>, contributionId: string): ExtensionContribution<T> | undefined;
  list<T>(point: ExtensionPoint<T>): readonly ExtensionContribution<T>[];
}

export interface PluginExtensions extends ExtensionReader {
  register<T>(point: ExtensionPoint<T>, contributionId: string, value: T): Disposable;
}

export function createExtensionPoint<T>(id: string): ExtensionPoint<T> {
  assertIdentifier(id, "extension point ID");
  return Object.freeze({ id });
}

type UnknownContribution = ExtensionContribution<unknown>;

/** Internal storage. Plugins receive an owner-scoped view instead. */
export class ExtensionRegistry implements ExtensionReader {
  readonly #points = new Map<string, Map<string, UnknownContribution>>();

  public has<T>(point: ExtensionPoint<T>, contributionId: string): boolean {
    return this.#points.get(point.id)?.has(contributionId) ?? false;
  }

  public get<T>(
    point: ExtensionPoint<T>,
    contributionId: string,
  ): ExtensionContribution<T> | undefined {
    return this.#points.get(point.id)?.get(contributionId) as
      | ExtensionContribution<T>
      | undefined;
  }

  public list<T>(point: ExtensionPoint<T>): readonly ExtensionContribution<T>[] {
    return Object.freeze(
      [...(this.#points.get(point.id)?.values() ?? [])] as ExtensionContribution<T>[],
    );
  }

  /** Creates a view that attributes every registration to one plugin. */
  public scoped(pluginId: string, resources: DisposableStore): PluginExtensions {
    const reader = this;

    return Object.freeze({
      has<T>(point: ExtensionPoint<T>, contributionId: string): boolean {
        return reader.has(point, contributionId);
      },
      get<T>(point: ExtensionPoint<T>, contributionId: string) {
        return reader.get(point, contributionId);
      },
      list<T>(point: ExtensionPoint<T>) {
        return reader.list(point);
      },
      register<T>(point: ExtensionPoint<T>, contributionId: string, value: T): Disposable {
        assertIdentifier(contributionId, "contribution ID");
        return resources.add(reader.#register(pluginId, point, contributionId, value));
      },
    });
  }

  #register<T>(
    pluginId: string,
    point: ExtensionPoint<T>,
    contributionId: string,
    value: T,
  ): Disposable {
    let contributions = this.#points.get(point.id);
    if (!contributions) {
      contributions = new Map();
      this.#points.set(point.id, contributions);
    }
    if (contributions.has(contributionId)) {
      throw new DuplicateContributionError(pluginId, point.id, contributionId);
    }

    const contribution = Object.freeze({ id: contributionId, pluginId, value });
    contributions.set(contributionId, contribution);

    return toDisposable(() => {
      if (contributions?.get(contributionId) !== contribution) return;
      contributions.delete(contributionId);
      if (contributions.size === 0) this.#points.delete(point.id);
    });
  }
}
