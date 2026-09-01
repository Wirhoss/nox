import {
  createContributionPoint,
  declareContribution,
  isConfigurable,
  validateContribution,
} from '@nox/extension-api';

import { crossedLogger } from './brokerServer';
import { keep, release, serverFor } from './instances';

import type {
  ContributionDeclaration,
  ContributionPoint,
  Disposable,
  ExtensionContext,
  ExtensionDefinition,
  ExtensionManifest,
  Logger,
  ServiceContainer,
  ServiceToken,
} from '@nox/extension-api';

/**
 * Running one extension's `activate` inside the confined child.
 *
 * The context it is handed is built here, out of what a JSON document can
 * carry and what the channel can reach. Everything else is absent and says so:
 * a package that asks for a service this boundary cannot yet carry is told
 * which one, by name, at the moment it asks — rather than receiving something
 * that looks like the service and is not.
 */

/** What the host tells the child in order to activate. */
interface ActivationPlan {
  readonly manifest: ExtensionManifest;
  /** The services the manifest declared, which is all it may reach. */
  readonly services: readonly string[];
}

/** One thing the extension contributed, as the host can read it. */
interface CrossedContribution {
  readonly declaration?: ContributionDeclaration;
  readonly id: string;
  readonly point: string;
  /**
   * The contribution itself, for points whose value is already data — an
   * authority's description, a language pack. Absent for the configurable ones,
   * which are reached through `declaration` and `create` instead.
   */
  readonly value?: unknown;
}

/**
 * The services that can cross today, and nothing else.
 *
 * A list rather than a best effort: every other host service is a live object
 * whose methods return more live objects, and a proxy that guessed at one would
 * be wrong in a way an extension could not see. The refusal names the service,
 * because the two things anyone can do about it — drop the dependency, or build
 * the crossing — both start with knowing which one it was.
 */
const CROSSABLE_SERVICES = new Set(['nox.logger']);

function crossableServices(logger: Logger, declared: readonly string[]): ServiceContainer {
  const available = new Map<string, unknown>([['nox.logger', logger]]);
  const reachable = new Set(declared.filter((id) => CROSSABLE_SERVICES.has(id)));

  const refuse = (id: string): never => {
    throw new TypeError(
      CROSSABLE_SERVICES.has(id)
        ? `This extension did not declare the service "${id}".`
        : `The service "${id}" cannot cross into a confined extension yet.`,
    );
  };

  return Object.freeze({
    get: <T>(token: ServiceToken<T>): T => {
      if (!reachable.has(token.id)) refuse(token.id);
      return available.get(token.id) as T;
    },
    has: <T>(token: ServiceToken<T>): boolean => reachable.has(token.id),
    tryGet: <T>(token: ServiceToken<T>): T | undefined =>
      reachable.has(token.id) ? (available.get(token.id) as T) : undefined,
  });
}

class ActivationServer {
  readonly #contributions = new Map<string, { point: string; value: unknown }>();
  readonly #definition: ExtensionDefinition;
  readonly #stopping = new AbortController();
  readonly #subscriptions: Disposable[] = [];

  constructor(definition: ExtensionDefinition) {
    this.#definition = definition;
  }

  public async activate(plan: ActivationPlan): Promise<void> {
    const logger = crossedLogger(plan.manifest.id);
    await this.#definition.activate(this.#context(plan, logger));
  }

  public async deactivate(): Promise<void> {
    this.#stopping.abort();
    // Reverse order, and awaited: a subscription may be asynchronous, and one
    // that is dropped on the floor leaves the thing it was releasing alive in a
    // process that is about to be told to exit.
    for (const subscription of this.#subscriptions.reverse()) await subscription.dispose();
    this.#subscriptions.length = 0;
    await this.#definition.deactivate?.();
  }

  /**
   * What the extension registered, as data.
   *
   * A configurable contribution crosses as its declaration — the JSON Schema of
   * its configuration and how many instances it allows — because that is
   * everything the host does with one until an operator has configured it. The
   * `create` half stays here, where the closure is.
   */
  public contributions(): readonly CrossedContribution[] {
    return [...this.#contributions].map(([key, { point, value }]) => {
      const id = key.slice(point.length + 1);
      if (!isConfigurable(value)) return { id, point, value };
      return { declaration: declareContribution(value), id, point };
    });
  }

  /**
   * Instantiates one configured contribution and keeps it under the host's
   * handle.
   *
   * The configuration is validated again here, against the real schema. The
   * host validated it too, against a schema rebuilt from JSON Schema — and a
   * `refine` does not survive that round trip. So a contribution with a custom
   * check is enforced here, and the failure arrives when the instance is built
   * rather than never.
   */
  public async create(
    point: string,
    contributionId: string,
    handle: string,
    config: unknown,
  ): Promise<void> {
    const contribution = this.#contributions.get(`${point}:${contributionId}`);
    if (contribution === undefined) {
      throw new Error(`This extension contributes no "${contributionId}" to "${point}".`);
    }
    if (!isConfigurable(contribution.value)) {
      throw new TypeError(`Contribution "${contributionId}" takes no configuration.`);
    }
    const checked = validateContribution(contribution.value, config);
    if (!checked.ok) {
      const [first] = checked.issues;
      throw new TypeError(
        `Configuration for "${contributionId}" is invalid: ${first?.message ?? 'unknown'}`,
      );
    }
    keep(handle, serverFor(point, await contribution.value.create(checked.value as never)));
  }

  public destroy(handle: string): void {
    release(handle);
  }

  #context(plan: ActivationPlan, logger: Logger): ExtensionContext {
    const register = <T>(
      point: ContributionPoint<T>,
      contributionId: string,
      value: T,
    ): Disposable => {
      const key = `${point.id}:${contributionId}`;
      if (this.#contributions.has(key)) {
        throw new Error(`"${contributionId}" is already contributed to "${point.id}".`);
      }
      this.#contributions.set(key, { point: point.id, value });
      return {
        dispose: (): void => {
          this.#contributions.delete(key);
        },
      };
    };

    // Reading other extensions' contributions is a host-side question and the
    // host is not here. Answering "nothing" would be a lie an extension could
    // not detect, so each reader says what it is instead.
    const unreadable = (): never => {
      throw new TypeError('A confined extension cannot read other extensions’ contributions.');
    };

    return Object.freeze({
      contributions: Object.freeze({
        get: unreadable,
        has: unreadable,
        list: unreadable,
        ownedBy: unreadable,
        register,
      }),
      extension: plan.manifest,
      logger,
      services: crossableServices(logger, plan.services),
      signal: this.#stopping.signal,
      storage: Object.freeze({
        get database(): never {
          throw new TypeError('Extension storage cannot cross into a confined extension yet.');
        },
      }) as unknown as ExtensionContext['storage'],
      subscriptions: Object.freeze({
        add: (disposable: Disposable): Disposable => {
          this.#subscriptions.push(disposable);
          return disposable;
        },
      }) as unknown as ExtensionContext['subscriptions'],
    });
  }
}

/** Rebuilt on this side so a point id from a message can address the real one. */
function pointFor(id: string): ContributionPoint<unknown> {
  return createContributionPoint<unknown>(id);
}

export { ActivationServer, CROSSABLE_SERVICES, pointFor };
export type { ActivationPlan, CrossedContribution };
