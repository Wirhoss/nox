import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { type SecretRow, secrets } from '../database/schema';
import { type Logger, silentLogger } from '../logger/logger';

import type { Database } from '../database/database';

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_FILE = '.secret-key';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

const secretIdSchema = z
  .string()
  .max(128, 'Secret IDs cannot exceed 128 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Use letters, digits, dots, dashes or underscores; paths are not secret IDs.',
  );

/** A safe value for ordinary configuration: it names a secret but never contains it. */
const secretRefSchema = z
  .object(
    { $secret: secretIdSchema },
    { error: 'Use a secret reference such as {"$secret":"OPENAI_API_KEY"}.' },
  )
  .readonly()
  .brand<'SecretRef'>();

type SecretRef = z.infer<typeof secretRefSchema>;

type SecretErrorCode = 'missing' | 'unreadable';

interface SecretConsumer {
  readonly extensionId: string;
  /** Config location, for example `providers.main.apiKey`. */
  readonly location: string;
}

interface SecretMetadata {
  readonly createdAt: number;
  readonly secretId: string;
  readonly updatedAt: number;
}

interface SecretStoreOptions {
  readonly dataDirectory: string;
  readonly database: Database;
  readonly logger?: Logger;
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
class SecretHandle {
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
 * surface without becoming ordinary configuration. The local master key is
 * generated once in DATA_DIR and never enters the database.
 *
 * Resolved values are snapshots. Replacing a secret affects future handles;
 * already composed contributions keep their old handle until they restart.
 */
class SecretStore {
  readonly #cache = new Map<string, Promise<string>>();
  readonly #consumers = new Map<string, Map<string, SecretConsumer>>();
  readonly #database: Database;
  readonly #key: Buffer;
  readonly #logger: Logger;

  private constructor(database: Database, key: Buffer, logger: Logger) {
    this.#database = database;
    this.#key = key;
    this.#logger = logger;
  }

  public static async open(options: SecretStoreOptions): Promise<SecretStore> {
    const hasStoredSecrets = await options.database.exclusive((database) =>
      Boolean(database.select({ secretId: secrets.secretId }).from(secrets).limit(1).get()),
    );
    const key = await loadOrCreateMasterKey(options.dataDirectory, hasStoredSecrets);
    return new SecretStore(options.database, key, options.logger ?? silentLogger);
  }

  public consumers(secretId: string): readonly SecretConsumer[] {
    return Object.freeze([...(this.#consumers.get(secretId)?.values() ?? [])]);
  }

  /** Metadata is safe for administrative surfaces; encrypted fields never leave this class. */
  public async list(): Promise<readonly SecretMetadata[]> {
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
    return Object.freeze(rows.map((row) => Object.freeze(row)));
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
    this.#logger.info({ secretId: id }, result.created ? 'Secret created.' : 'Secret replaced.');
    return result.metadata;
  }

  /** Deletes a managed value. Existing handles remain snapshots until their owners restart. */
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
    if (deleted) this.#logger.info({ secretId: id }, 'Secret deleted.');
    return deleted;
  }

  public async resolve(reference: SecretRef, consumer: SecretConsumer): Promise<SecretHandle> {
    const { $secret: secretId } = secretRefSchema.parse(reference);
    const consumerKey = `${consumer.extensionId}\u0000${consumer.location}`;
    let consumers = this.#consumers.get(secretId);
    if (consumers === undefined) {
      consumers = new Map();
      this.#consumers.set(secretId, consumers);
    }
    consumers.set(consumerKey, Object.freeze({ ...consumer }));

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

/** Config factories see the same shape they declared, with references replaced by handles. */
type ResolvedSecrets<T> = T extends SecretRef
  ? SecretHandle
  : T extends readonly unknown[]
    ? { [K in keyof T]: ResolvedSecrets<T[K]> }
    : T extends object
      ? { [K in keyof T]: ResolvedSecrets<T[K]> }
      : T;

async function resolveSecrets<T>(
  value: T,
  store: SecretStore,
  consumer: SecretConsumer,
): Promise<ResolvedSecrets<T>> {
  return resolveAt(value, store, consumer, []) as Promise<ResolvedSecrets<T>>;
}

async function resolveAt(
  value: unknown,
  store: SecretStore,
  consumer: SecretConsumer,
  path: readonly string[],
): Promise<unknown> {
  if (isSecretRef(value)) {
    return store.resolve(value, {
      ...consumer,
      location: [consumer.location, ...path].join('.'),
    });
  }
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) => resolveAt(item, store, consumer, [...path, String(index)])),
    );
  }
  if (value === null || typeof value !== 'object') return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [
      key,
      await resolveAt(item, store, consumer, [...path, key]),
    ]),
  );
  return Object.fromEntries(entries);
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

export { resolveSecrets, SecretError, SecretHandle, secretIdSchema, secretRefSchema, SecretStore };

export type {
  ResolvedSecrets,
  SecretConsumer,
  SecretErrorCode,
  SecretMetadata,
  SecretRef,
  SecretStoreOptions,
};
