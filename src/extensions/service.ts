import { DuplicateServiceError, MissingServiceError } from './error';
import { assertIdentifier } from './identifier';

declare const serviceType: unique symbol;

/** A host-owned dependency, addressed by token rather than imported. */
interface ServiceToken<T> {
  readonly id: string;
  readonly [serviceType]?: (value: T) => T;
}

interface ServiceContainer {
  get<T>(token: ServiceToken<T>): T;
  has<T>(token: ServiceToken<T>): boolean;
  tryGet<T>(token: ServiceToken<T>): T | undefined;
}

function createServiceToken<T>(id: string): ServiceToken<T> {
  assertIdentifier(id, 'service ID');
  return Object.freeze({ id });
}

/** Host-owned services made available to every extension. Never a global. */
class ServiceCollection implements ServiceContainer {
  readonly #services = new Map<string, unknown>();

  #locked = false;

  public get<T>(token: ServiceToken<T>): T {
    const service = this.tryGet(token);
    if (service === undefined) {
      throw new MissingServiceError(token.id);
    }
    return service;
  }

  public has<T>(token: ServiceToken<T>): boolean {
    return this.#services.has(token.id);
  }

  /** Services are fixed before activation: an extension cannot see a moving set. */
  public provide<T>(token: ServiceToken<T>, service: T): this {
    if (this.#locked) {
      throw new Error('Services cannot be changed after extension activation has started.');
    }
    if (this.#services.has(token.id)) {
      throw new DuplicateServiceError(token.id);
    }
    this.#services.set(token.id, service);
    return this;
  }

  public tryGet<T>(token: ServiceToken<T>): T | undefined {
    return this.#services.get(token.id) as T | undefined;
  }

  /** @internal */
  public lock(): void {
    this.#locked = true;
  }
}

export { createServiceToken, ServiceCollection };

export type { ServiceContainer, ServiceToken };
