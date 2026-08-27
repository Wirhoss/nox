import { DuplicateServiceError, MissingServiceError } from './error';

import type { ServiceContainer, ServiceToken } from '@nox/extension-api';

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
}

export { ServiceCollection };
