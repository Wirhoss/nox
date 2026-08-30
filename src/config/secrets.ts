import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type SecretConsumer,
  type SecretHandle as SecretHandleContract,
  secretIdSchema,
  type SecretRef,
  type SecretReference,
  secretRefSchema,
  type SecretSummary,
} from '@nox/extension-api';
import { asc, eq } from 'drizzle-orm';

import { type SecretRow, secrets } from '../database/schema';
import { type Logger, silentLogger } from '../logger/logger';

import type { Database } from '../database/database';

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_FILE = '.secret-key';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

type SecretErrorCode = 'missing' | 'unreadable';

interface SecretMetadata {
  readonly createdAt: number;
  readonly secretId: string;
  readonly updatedAt: number;
}

interface SecretStoreOptions {
  /** Reconciles future consumers after a value changes; existing handles stay immutable. */
  readonly changed?: () => Promise<void> | void;
  readonly dataDirectory: string;
  readonly database: Database;
  readonly logger?: Logger;
  /**
   * Read on every call rather than captured. The store opens before the
   * extensions that describe the configuration have activated, and configuration
   * keeps changing afterwards — an entry saved through the settings surface names
   * its secret immediately, with no restart in between.
   */
  readonly references?: () => readonly SecretReference[];
}

interface EncryptedSecret {
  readonly authTag: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly version: number;
}

class SecretLoadError extends Error {
  public readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

class SecretError extends Error {
  public readonly code: SecretErrorCode;
  public readonly consumer: SecretConsumer;
  public readonly secretId: string;

  constructor(
    code: SecretErrorCode,
    secretId: string,
    consumer: SecretConsumer,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Secret "${secretId}" required by ${consumer.location} ${message}`, options);
    this.name = 'SecretError';
    this.code = code;
    this.consumer = consumer;
    this.secretId = secretId;
  }
}

/**
 * An opaque runtime capability. The private value is neither enumerable nor JSON
 * serializable; using it requires an explicit call at the network boundary.
 */
class SecretHandle implements SecretHandleContract {
  readonly #value: string;

  public readonly id: string;

  constructor(id: string, value: string) {
    this.id = secretIdSchema.parse(id);
    if (value.length === 0) throw new TypeError(`Secret "${id}" cannot be empty.`);
    this.#value = value;
    Object.freeze(this);
  }

  public reveal(): string {
    return this.#value;
  }

  public toJSON(): string {
    return '[redacted]';
  }

  public toString(): string {
    return '[redacted]';
  }
}

/**
 * Host-owned, application-managed secret storage. Values are encrypted in the
 * Nox database and can be created, replaced and deleted by an administrative
 * surface without becoming ordinary configuration; the local master key is
 * generated once in DATA_DIR and never enters the database.
 *
 * Resolved values are snapshots: replacing a secret affects future handles,
 * while already composed generations keep the old handle until their work
 * settles. An ID is known because a value was written for it, because
 * configuration names it, or both, and `list` is that union — so a credential
 * something needs is something an operator can see and answer, rather than a
 * failed boot report.
 */
class SecretStore {
  readonly #cache = new Map<string, Promise<string>>();
  readonly #changed: () => Promise<void> | void;
  readonly #consumers = new Map<string, Map<string, SecretConsumer>>();
  readonly #database: Database;
  readonly #key: Buffer;
  readonly #logger: Logger;
  readonly #references: () => readonly SecretReference[];

  #revision = 0;

  private constructor(
    database: Database,
    key: Buffer,
    logger: Logger,
    references: () => readonly SecretReference[],
    changed: () => Promise<void> | void,
  ) {
    this.#changed = changed;
    this.#database = database;
    this.#key = key;
    this.#logger = logger;
    this.#references = references;
  }

  public static async open(options: SecretStoreOptions): Promise<SecretStore> {
    const hasStoredSecrets = await options.database.exclusive((database) =>
      Boolean(database.select({ secretId: secrets.secretId }).from(secrets).limit(1).get()),
    );
    const key = await loadOrCreateMasterKey(options.dataDirectory, hasStoredSecrets);
    return new SecretStore(
      options.database,
      key,
      options.logger ?? silentLogger,
      options.references ?? (() => Object.freeze([])),
      options.changed ?? (() => undefined),
    );
  }

  /**
   * What has resolved this ID since the process started. Narrower than
   * `references` on purpose: a reference is a fact about the configuration,
   * while a consumer is something that resolved a snapshot of the value in this
   * process, which explains which generations reconciliation may replace.
   */
  /** Monotonic input to runtime signatures; values themselves never leave the store. */
  public get revision(): number {
    return this.#revision;
  }

  public consumers(secretId: string): readonly SecretConsumer[] {
    return Object.freeze([...(this.#consumers.get(secretId)?.values() ?? [])]);
  }

  /** Every place the configuration names this ID, composed or not. */
  public references(secretId: string): readonly SecretReference[] {
    return Object.freeze(
      this.#references()
        .filter((reference) => reference.secretId === secretId)
        .sort((a, b) => a.location.localeCompare(b.location)),
    );
  }

  /**
   * Every known secret ID: stored, referenced, or both. Metadata is safe for
   * administrative surfaces; encrypted fields never leave this class.
   *
   * Sorted by ID rather than by where the knowledge came from, because to an
   * operator these are one list — a credential that exists and one that is still
   * expected sit next to each other, and the difference is a field on the row.
   */
  public async list(): Promise<readonly SecretSummary[]> {
    const rows = await this.#database.exclusive((database) =>
      database
        .select({
          createdAt: secrets.createdAt,
          secretId: secrets.secretId,
          updatedAt: secrets.updatedAt,
        })
        .from(secrets)
        .orderBy(asc(secrets.secretId))
        .all(),
    );

    const summaries = new Map<string, SecretSummary>(
      rows.map((row) => [
        row.secretId,
        { ...row, references: Object.freeze([]), stored: true } satisfies SecretSummary,
      ]),
    );
    for (const reference of this.#references()) {
      const known = summaries.get(reference.secretId) ?? {
        references: Object.freeze([]),
        secretId: reference.secretId,
        stored: false,
      };
      summaries.set(reference.secretId, {
        ...known,
        references: Object.freeze([...known.references, reference]),
      });
    }

    return Object.freeze(
      [...summaries.values()]
        .sort((a, b) => a.secretId.localeCompare(b.secretId))
        .map((summary) =>
          Object.freeze({
            ...summary,
            references: Object.freeze(
              [...summary.references].sort((a, b) => a.location.localeCompare(b.location)),
            ),
          }),
        ),
    );
  }

  public async has(secretId: string): Promise<boolean> {
    const id = secretIdSchema.parse(secretId);
    return this.#database.exclusive((database) =>
      Boolean(
        database
          .select({ secretId: secrets.secretId })
          .from(secrets)
          .where(eq(secrets.secretId, id))
          .get(),
      ),
    );
  }

  /** Creates or replaces a value without ever returning it. */
  public async set(secretId: string, value: string): Promise<SecretMetadata> {
    const id = secretIdSchema.parse(secretId);
    if (value.length === 0) throw new TypeError(`Secret "${id}" cannot be empty.`);

    const encrypted = encryptSecret(id, value, this.#key);
    const result = await this.#database.transaction((database) => {
      const existing = database
        .select({ createdAt: secrets.createdAt, updatedAt: secrets.updatedAt })
        .from(secrets)
        .where(eq(secrets.secretId, id))
        .get();
      const now = Math.max(Date.now(), (existing?.updatedAt ?? -1) + 1);
      const createdAt = existing?.createdAt ?? now;

      database
        .insert(secrets)
        .values({ ...encrypted, createdAt, secretId: id, updatedAt: now })
        .onConflictDoUpdate({
          set: { ...encrypted, updatedAt: now },
          target: secrets.secretId,
        })
        .run();

      return {
        created: existing === undefined,
        metadata: Object.freeze({ createdAt, secretId: id, updatedAt: now }),
      };
    });

    this.#cache.delete(id);
    this.#revision += 1;
    this.#logger.info({ secretId: id }, result.created ? 'Secret created.' : 'Secret replaced.');
    await this.#changed();
    return result.metadata;
  }

  /** Deletes a managed value. Existing handles remain snapshots while their work settles. */
  public async delete(secretId: string): Promise<boolean> {
    const id = secretIdSchema.parse(secretId);
    const deleted = await this.#database.transaction((database) => {
      const exists = Boolean(
        database
          .select({ secretId: secrets.secretId })
          .from(secrets)
          .where(eq(secrets.secretId, id))
          .get(),
      );
      if (exists) database.delete(secrets).where(eq(secrets.secretId, id)).run();
      return exists;
    });
    this.#cache.delete(id);
    if (deleted) {
      this.#revision += 1;
      this.#logger.info({ secretId: id }, 'Secret deleted.');
      await this.#changed();
    }
    return deleted;
  }

  /**
   * The value behind one reference, or `undefined` when nothing is stored for it.
   *
   * Absence is not an error here, and that is deliberate. Whether a credential is
   * required is a property of the contribution that reads it, not of the store,
   * and a store that threw would make every unfilled optional key a failed boot —
   * which is precisely how a missing credential used to be discovered.
   *
   * A value that exists but cannot be decrypted still throws. That is a broken
   * installation rather than an unfilled requirement, and treating the two alike
   * would hide a key-management failure behind a puzzling authentication one.
   */
  public async resolve(
    reference: SecretRef,
    consumer: SecretConsumer,
  ): Promise<SecretHandle | undefined> {
    const { $secret: secretId } = secretRefSchema.parse(reference);
    this.#recordConsumer(secretId, consumer);

    let pending = this.#cache.get(secretId);
    if (pending === undefined) {
      pending = this.#load(secretId);
      this.#cache.set(secretId, pending);
    }

    let value: string;
    try {
      value = await pending;
    } catch (error) {
      if (error instanceof SecretLoadError) {
        if (error.code === 'missing') {
          this.#logger.debug(
            { extensionId: consumer.extensionId, location: consumer.location, secretId },
            'Secret named by configuration has no stored value.',
          );
          return undefined;
        }
        throw new SecretError(error.code, secretId, consumer, error.message, { cause: error });
      }
      throw error;
    }

    this.#logger.debug(
      { extensionId: consumer.extensionId, location: consumer.location, secretId },
      'Secret resolved.',
    );
    return new SecretHandle(secretId, value);
  }

  /**
   * Recorded before the value is read, so a credential is attributed to whoever
   * asked for it whether or not one exists to give them.
   */
  #recordConsumer(secretId: string, consumer: SecretConsumer): void {
    const consumerKey = `${consumer.extensionId}\u0000${consumer.location}`;
    let consumers = this.#consumers.get(secretId);
    if (consumers === undefined) {
      consumers = new Map();
      this.#consumers.set(secretId, consumers);
    }
    consumers.set(consumerKey, Object.freeze({ ...consumer }));
  }

  async #load(secretId: string): Promise<string> {
    const row = await this.#database.exclusive((database) =>
      database.select().from(secrets).where(eq(secrets.secretId, secretId)).get(),
    );
    if (row === undefined) throw new SecretLoadError('missing', 'is not configured.');

    try {
      return decryptSecret(row, this.#key);
    } catch (error) {
      throw new SecretLoadError('unreadable', 'could not be decrypted.', { cause: error });
    }
  }
}

/**
 * Config factories see the same shape they declared, with references replaced by
 * handles.
 *
 * A reference whose secret has no stored value leaves its property absent rather
 * than present-and-undefined, so the contribution's own runtime schema is what
 * decides whether that is acceptable: an optional credential simply is not there,
 * and a required one fails that parse. The type describes a fully supplied
 * installation; the parse is what enforces it.
 */
type ResolvedSecrets<T> = T extends SecretRef
  ? SecretHandle
  : T extends readonly unknown[]
    ? { [K in keyof T]: ResolvedSecrets<T[K]> }
    : T extends object
      ? { [K in keyof T]: ResolvedSecrets<T[K]> }
      : T;

/** One configured entry, with every secret it names replaced by a handle. */
interface ResolvedEntry<T> {
  /** Secret IDs this entry names that have no stored value, in reference order. */
  readonly missing: readonly SecretReference[];
  readonly value: ResolvedSecrets<T>;
}

async function resolveSecrets<T>(
  value: T,
  store: SecretStore,
  consumer: SecretConsumer,
): Promise<ResolvedEntry<T>> {
  const missing: SecretReference[] = [];
  const resolved = (await resolveAt(value, store, consumer, [], missing)) as ResolvedSecrets<T>;
  return Object.freeze({ missing: Object.freeze(missing), value: resolved });
}

/**
 * Builds a contribution from its configured entry, with credentials in place.
 *
 * The wrapping exists for one failure that is otherwise unreadable: a required
 * credential whose secret is unset arrives as an absent property, so the
 * contribution's schema rejects it with a type error naming a field and nothing
 * else. Here the entry's own unstored references are known, so the error can say
 * which secret is missing and where it was named.
 */
async function composeWithSecrets<TConfig, TValue>(
  entry: TConfig,
  store: SecretStore,
  consumer: SecretConsumer,
  create: (config: ResolvedSecrets<TConfig>) => TValue,
): Promise<TValue> {
  const resolved = await resolveSecrets(entry, store, consumer);
  try {
    return create(resolved.value);
  } catch (error) {
    if (resolved.missing.length === 0) throw error;
    const named = resolved.missing
      .map((reference) => `"${reference.secretId}" at ${reference.location}`)
      .join(', ');
    throw new Error(
      `${consumer.location} could not be built, and ${
        resolved.missing.length === 1 ? 'the secret it names has' : 'the secrets it names have'
      } no stored value: ${named}. Store ${
        resolved.missing.length === 1 ? 'it' : 'them'
      } in the secrets surface, then retry activation.`,
      { cause: error },
    );
  }
}

async function resolveAt(
  value: unknown,
  store: SecretStore,
  consumer: SecretConsumer,
  path: readonly string[],
  missing: SecretReference[],
): Promise<unknown> {
  if (isSecretRef(value)) {
    const location = [consumer.location, ...path].join('.');
    const handle = await store.resolve(value, { ...consumer, location });
    if (handle === undefined) missing.push(Object.freeze({ location, secretId: value.$secret }));
    return handle;
  }
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) =>
        resolveAt(item, store, consumer, [...path, String(index)], missing),
      ),
    );
  }
  if (value === null || typeof value !== 'object') return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const entries = await Promise.all(
    Object.entries(value).map(
      async ([key, item]) =>
        [key, await resolveAt(item, store, consumer, [...path, key], missing)] as const,
    ),
  );
  // An unresolved reference leaves nothing behind rather than an explicit
  // `undefined`: an optional field has to read as absent for its schema to
  // accept it, and `{ apiKey: undefined }` is not absent to a `.parse`.
  return Object.fromEntries(entries.filter(([, item]) => item !== undefined));
}

/**
 * Every secret named inside one configured value, with the path that names it.
 *
 * Walking configuration for references is not the host guessing where a
 * credential might be: a reference only validates where a contribution's schema
 * declared `secretRefSchema`, so every position found here is one an extension
 * asked for.
 */
function findSecretReferences(value: unknown, basePath = ''): readonly SecretReference[] {
  const found: SecretReference[] = [];
  visitReferences(value, basePath, found);
  return Object.freeze(found.sort((a, b) => a.location.localeCompare(b.location)));
}

function visitReferences(value: unknown, path: string, found: SecretReference[]): void {
  if (isSecretRef(value)) {
    found.push(Object.freeze({ location: path, secretId: value.$secret }));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitReferences(item, `${path}.${String(index)}`, found);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    visitReferences(item, path.length === 0 ? key : `${path}.${key}`, found);
  }
}

function isSecretRef(value: unknown): value is SecretRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === '$secret' && typeof entries[0][1] === 'string';
}

function encryptSecret(secretId: string, value: string, key: Buffer): EncryptedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(ENVELOPE_VERSION, secretId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    version: ENVELOPE_VERSION,
  };
}

function decryptSecret(row: SecretRow, key: Buffer): string {
  if (row.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted secret envelope version ${String(row.version)}.`);
  }

  const nonce = Buffer.from(row.nonce, 'base64');
  const authTag = Buffer.from(row.authTag, 'base64');
  if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('Invalid encrypted secret envelope.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(associatedData(row.version, row.secretId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function associatedData(version: number, secretId: string): Buffer {
  return Buffer.from(`nox:secret:${String(version)}\u0000${secretId}`, 'utf8');
}

async function loadOrCreateMasterKey(
  dataDirectory: string,
  hasStoredSecrets: boolean,
): Promise<Buffer> {
  await mkdir(dataDirectory, { recursive: true });
  const keyPath = join(dataDirectory, MASTER_KEY_FILE);

  try {
    return validateMasterKey(await readFile(keyPath), keyPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  if (hasStoredSecrets) {
    throw new Error(
      `Secret master key is missing at ${keyPath}; refusing to replace a key that protects stored secrets.`,
    );
  }

  const generated = randomBytes(MASTER_KEY_BYTES);
  try {
    await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    // Another process may have initialized the same installation first.
    if (!isExistingFile(error)) throw error;
    return validateMasterKey(await readFile(keyPath), keyPath);
  }
}

function validateMasterKey(value: Buffer, keyPath: string): Buffer {
  if (value.length !== MASTER_KEY_BYTES) {
    throw new Error(`Secret master key at ${keyPath} must contain exactly 32 bytes.`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export {
  composeWithSecrets,
  findSecretReferences,
  resolveSecrets,
  SecretError,
  SecretHandle,
  SecretStore,
};

export type { ResolvedEntry, ResolvedSecrets, SecretErrorCode, SecretMetadata, SecretStoreOptions };
