import {
  DuplicateServiceError,
  MissingServiceError,
  RestrictedServiceError,
  UndeclaredServiceError,
} from './error';

import type { ExtensionOrigin } from './catalog';
import type { ServiceContainer, ServiceToken } from '@nox/extension-api';

/**
 * One extension's view of the host services: exactly the IDs its manifest
 * declared, minus anything its origin does not entitle it to.
 *
 * Every question goes through the same gate, `has` and `tryGet` included. The
 * softer alternative — answering false or undefined for an undeclared ID —
 * would turn a missing line in a manifest into a feature that quietly does not
 * run, which is the failure this whole model exists to make impossible.
 *
 * The two refusals are kept apart on purpose. Undeclared is fixed by editing
 * the manifest; restricted cannot be fixed at all, and an author told the wrong
 * one goes looking in the wrong place.
 */
class ScopedServices implements ServiceContainer {
  readonly #declared: ReadonlySet<string>;
  readonly #extensionId: string;
  readonly #origin: ExtensionOrigin;
  readonly #services: ServiceContainer;

  constructor(
    services: ServiceContainer,
    extensionId: string,
    declared: readonly string[],
    origin: ExtensionOrigin,
  ) {
    this.#declared = new Set(declared);
    this.#extensionId = extensionId;
    this.#origin = origin;
    this.#services = services;
  }

  public get<T>(token: ServiceToken<T>): T {
    this.#assertDeclared(token);
    return this.#services.get(token);
  }

  public has<T>(token: ServiceToken<T>): boolean {
    this.#assertDeclared(token);
    return this.#services.has(token);
  }

  public tryGet<T>(token: ServiceToken<T>): T | undefined {
    this.#assertDeclared(token);
    return this.#services.tryGet(token);
  }

  #assertDeclared<T>(token: ServiceToken<T>): void {
    if (token.controlPlane === true && this.#origin !== 'builtin') {
      throw new RestrictedServiceError(this.#extensionId, token.id);
    }
    if (!this.#declared.has(token.id)) {
      throw new UndeclaredServiceError(this.#extensionId, token.id);
    }
  }
}

/** Host-owned services made available to every extension. Never a global. */
class ServiceCollection implements ServiceContainer {
  readonly #services = new Map<string, unknown>();
  #locked = false;

  public get<T>(token: ServiceToken<T>): T {
    const service = this.tryGet(token);
    if (service === undefined) throw new MissingServiceError(token.id);
    return service;
  }

  public has<T>(token: ServiceToken<T>): boolean {
    return this.#services.has(token.id);
  }

  public provide<T>(token: ServiceToken<T>, service: T): this {
    if (this.#locked) {
      throw new Error('Services cannot be changed after extension activation has started.');
    }
    if (this.#services.has(token.id)) throw new DuplicateServiceError(token.id);
    this.#services.set(token.id, service);
    return this;
  }

  public tryGet<T>(token: ServiceToken<T>): T | undefined {
    return this.#services.get(token.id) as T | undefined;
  }

  public lock(): void {
    this.#locked = true;
  }

  /**
   * The container as one extension may see it.
   *
   * Mirrors how contributions are handed out: an extension never holds the
   * host's own registry, only a view that knows whose it is.
   */
  public scoped(
    extensionId: string,
    declared: readonly string[] = [],
    origin: ExtensionOrigin = 'builtin',
  ): ServiceContainer {
    return new ScopedServices(this, extensionId, declared, origin);
  }
}

export { ScopedServices, ServiceCollection };
