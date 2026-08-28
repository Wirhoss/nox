import { z } from 'zod';

import { assertIdentifier } from './schemas.js';

const EXTENSION_API_VERSION = '0.1.0';

type MaybePromise<T> = PromiseLike<T> | T;

interface Logger {
  child(name: string): Logger;
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  trace(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

const silentLogger: Logger = Object.freeze({
  child: () => silentLogger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
});

function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

/** Serializes asynchronous work in submission order without poisoning later tasks. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  public get idle(): Promise<void> {
    return this.#tail.then(
      () => undefined,
      () => undefined,
    );
  }

  public async run<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    const current = previous.then(
      async () => task(),
      async () => task(),
    );
    this.#tail = current.catch(() => undefined);
    return current;
  }
}

interface Disposable {
  dispose(): Promise<void> | void;
}

interface DisposableRegistry {
  add<T extends Disposable>(disposable: T): T;
}

interface ExtensionStateEntry<T> {
  readonly key: string;
  readonly value: T;
}

/** A synchronous transaction over durable JSON state owned by one extension. */
interface ExtensionStateTransaction {
  delete(collection: string, key: string): boolean;
  entries<T>(collection: string, parse: (value: unknown) => T): readonly ExtensionStateEntry<T>[];
  get<T>(collection: string, key: string, parse: (value: unknown) => T): T | undefined;
  set(collection: string, key: string, value: unknown): void;
}

/**
 * Durable extension-owned state. Every callback is atomic and must remain
 * synchronous; values must be serializable as JSON.
 */
interface ExtensionStorage {
  transact<T>(run: (transaction: ExtensionStateTransaction) => T): Promise<T>;
}

declare const serviceType: unique symbol;

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

declare const contributionType: unique symbol;

interface ContributionPoint<T> {
  readonly id: string;
  readonly [contributionType]?: T;
}

interface Contribution<T> {
  readonly id: string;
  readonly extensionId: string;
  readonly value: T;
}

interface ContributionDescriptor {
  readonly id: string;
  readonly point: string;
}

interface ContributionReader {
  get<T>(point: ContributionPoint<T>, contributionId: string): Contribution<T> | undefined;
  has<T>(point: ContributionPoint<T>, contributionId: string): boolean;
  list<T>(point: ContributionPoint<T>): readonly Contribution<T>[];
  ownedBy(extensionId: string): readonly ContributionDescriptor[];
}

interface ExtensionContributions extends ContributionReader {
  register<T>(point: ContributionPoint<T>, contributionId: string, value: T): Disposable;
}

function createContributionPoint<T>(id: string): ContributionPoint<T> {
  assertIdentifier(id, 'contribution point ID');
  return Object.freeze({ id });
}

type ContributionConfigSchema = z.ZodObject<{ type: z.ZodLiteral<string> }>;

type ResolvedSecrets<T> = T extends { readonly $secret: string }
  ? import('./schemas.js').SecretHandle
  : T extends readonly unknown[]
    ? { [K in keyof T]: ResolvedSecrets<T[K]> }
    : T extends object
      ? { [K in keyof T]: ResolvedSecrets<T[K]> }
      : T;

/**
 * How many configured instances of one contribution can exist.
 *
 * `single` is the default because it is the ordinary case, and saying so is what
 * keeps the exception visible. A transport is bound to one credential; a
 * capability like scheduling or configuration access belongs to this Nox rather
 * than to a remote service, and a second copy of it partitions nothing real.
 *
 * `many` is right when an instance is the address of an independent remote
 * service that a deployment genuinely wants several of, with consumers choosing
 * between them — which is what a provider is, and why a blueprint names one.
 *
 * A `single` contribution owns its own name: its entry must be called exactly
 * what the contribution is called, which is also its config `type`. That is one
 * rule doing two jobs — it reserves the name, and it makes a second instance
 * impossible, because two entries cannot share one key.
 */
type ContributionInstances = 'many' | 'single';

interface ConfigurableContribution<TSchema extends ContributionConfigSchema, TValue> {
  readonly configSchema: TSchema;
  readonly instances?: ContributionInstances;
  create(config: ResolvedSecrets<z.infer<TSchema>>): TValue;
}

/** What a contribution declared, or the default nothing has to declare. */
function contributionInstances(value: UnknownConfigurable): ContributionInstances {
  return value.instances ?? 'single';
}

type UnknownConfigurable = ConfigurableContribution<ContributionConfigSchema, unknown>;

function isConfigurable(value: unknown): value is UnknownConfigurable {
  if (typeof value !== 'object' || value === null || !('configSchema' in value)) return false;
  return value.configSchema instanceof z.ZodObject;
}

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

interface ExtensionManifest {
  readonly engines: {
    readonly extensionApi: string;
    readonly nox: string;
  };
  readonly id: string;
  readonly main: string;
  readonly schemaVersion: 1;
  readonly version: string;
}

interface ExtensionContext {
  readonly contributions: ExtensionContributions;
  readonly extension: ExtensionManifest;
  readonly logger: Logger;
  readonly services: ServiceContainer;
  readonly signal: AbortSignal;
  readonly storage: ExtensionStorage;
  readonly subscriptions: DisposableRegistry;
}

interface ExtensionDefinition {
  activate(context: ExtensionContext): MaybePromise<void>;
  deactivate?(): MaybePromise<void>;
}

function isExtensionDefinition(value: unknown): value is ExtensionDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'activate') === 'function'
  );
}

function defineExtension<const T extends ExtensionDefinition>(extension: T): T {
  if (!isExtensionDefinition(extension)) {
    throw new TypeError('An extension must export an activate(context) function.');
  }
  return Object.freeze({ ...extension });
}

export {
  assertDiscriminator,
  contributionInstances,
  createContributionPoint,
  createServiceToken,
  defineExtension,
  EXTENSION_API_VERSION,
  isConfigurable,
  isExtensionDefinition,
  Mutex,
  silentLogger,
  stableStringify,
};

export type {
  ConfigurableContribution,
  Contribution,
  ContributionConfigSchema,
  ContributionDescriptor,
  ContributionInstances,
  ContributionPoint,
  ContributionReader,
  Disposable,
  DisposableRegistry,
  ExtensionContext,
  ExtensionContributions,
  ExtensionDefinition,
  ExtensionManifest,
  ExtensionStateEntry,
  ExtensionStateTransaction,
  ExtensionStorage,
  Logger,
  MaybePromise,
  ResolvedSecrets,
  ServiceContainer,
  ServiceToken,
  UnknownConfigurable,
};
