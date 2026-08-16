import { DuplicateServiceError, MissingServiceError } from "./errors.ts";
import { assertIdentifier } from "./manifest.ts";

declare const serviceType: unique symbol;

export interface ServiceToken<T> {
  readonly id: string;
  readonly [serviceType]?: (value: T) => T;
}

export interface ServiceContainer {
  has<T>(token: ServiceToken<T>): boolean;
  get<T>(token: ServiceToken<T>): T;
  tryGet<T>(token: ServiceToken<T>): T | undefined;
}

export function createServiceToken<T>(id: string): ServiceToken<T> {
  assertIdentifier(id, "service ID");
  return Object.freeze({ id });
}

/** Host-owned services made available to every plugin. */
export class ServiceCollection implements ServiceContainer {
  readonly #services = new Map<string, unknown>();
  #locked = false;

  public provide<T>(token: ServiceToken<T>, service: T): this {
    if (this.#locked) {
      throw new Error("Services cannot be changed after plugin activation has started.");
    }
    if (this.#services.has(token.id)) {
      throw new DuplicateServiceError(token.id);
    }
    this.#services.set(token.id, service);
    return this;
  }

  public has<T>(token: ServiceToken<T>): boolean {
    return this.#services.has(token.id);
  }

  public get<T>(token: ServiceToken<T>): T {
    const service = this.tryGet(token);
    if (service === undefined) {
      throw new MissingServiceError(token.id);
    }
    return service;
  }

  public tryGet<T>(token: ServiceToken<T>): T | undefined {
    return this.#services.get(token.id) as T | undefined;
  }

  /** @internal */
  public lock(): void {
    this.#locked = true;
  }
}
