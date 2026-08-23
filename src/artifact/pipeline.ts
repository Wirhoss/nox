import { createHash } from 'node:crypto';
import { link, mkdir, open as openFile, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { artifactBlobs, artifacts } from '../database/schema';
import { type Logger, silentLogger } from '../logger/logger';
import { ArtifactNotFoundError, ArtifactTooLargeError } from './error';
import { PROBE_BYTES, probeArtifact } from './probe';
import {
  type ArtifactByteSource,
  type ArtifactIngestInput,
  type ArtifactPayload,
  artifactProvenanceSchema,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactScope,
  artifactScopeSchema,
} from './types';

import type { Database } from '../database/database';

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface ArtifactPipelineOptions {
  readonly dataDirectory: string;
  readonly database: Database;
  readonly logger?: Logger;
  readonly maxArtifactBytes?: number;
}

function isFileError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function normalizedFilename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const leaf = value
    .split(/[\\/]/u)
    .at(-1)
    ?.replaceAll(/[\s\S]/gu, (character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? '' : character;
    })
    .trim();
  if (leaf === undefined || leaf.length === 0) return undefined;
  return leaf.normalize('NFC').slice(0, 255);
}

function sameScope(left: ArtifactScope, right: ArtifactScope): boolean {
  return left.id === right.id && left.type === right.type;
}

async function* chunksFrom(source: ArtifactByteSource): AsyncGenerator<Uint8Array> {
  const iterable = source instanceof Blob ? source.stream() : source;
  for await (const chunk of iterable) yield chunk;
}

function freezeRecord(row: typeof artifacts.$inferSelect & { size: number }): ArtifactRecord {
  return Object.freeze({
    artifactId: row.artifactId,
    blobHash: row.blobHash,
    createdAt: row.createdAt,
    ...(row.declaredMediaType === null ? {} : { declaredMediaType: row.declaredMediaType }),
    ...(row.detectedMediaType === null ? {} : { detectedMediaType: row.detectedMediaType }),
    ...(row.filename === null ? {} : { filename: row.filename }),
    mediaType: row.mediaType,
    provenance: Object.freeze({
      ...row.provenance,
      ...(row.provenance.details === undefined
        ? {}
        : { details: Object.freeze({ ...row.provenance.details }) }),
    }),
    scope: Object.freeze({ id: row.scopeId, type: row.scopeType }),
    size: row.size,
  });
}

function artifactRef(record: ArtifactRecord): ArtifactRef {
  return Object.freeze({
    artifactId: record.artifactId,
    ...(record.filename === undefined ? {} : { filename: record.filename }),
    mediaType: record.mediaType,
    size: record.size,
  });
}

/**
 * The one door through which durable bytes enter Nox. It owns physical layout,
 * hashing and logical metadata; callers retain only an artifact reference.
 */
class ArtifactPipeline {
  readonly #blobsDirectory: string;
  readonly #database: Database;
  readonly #directory: string;
  readonly #logger: Logger;
  readonly #maxArtifactBytes: number;
  readonly #temporaryDirectory: string;

  private constructor(options: ArtifactPipelineOptions) {
    this.#directory = join(options.dataDirectory, 'artifacts');
    this.#blobsDirectory = join(this.#directory, 'blobs', 'sha256');
    this.#temporaryDirectory = join(this.#directory, 'tmp');
    this.#database = options.database;
    this.#logger = options.logger ?? silentLogger;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes <= 0) {
      throw new RangeError('maxArtifactBytes must be a positive safe integer.');
    }
  }

  public static async open(options: ArtifactPipelineOptions): Promise<ArtifactPipeline> {
    const pipeline = new ArtifactPipeline(options);
    await Promise.all([
      mkdir(pipeline.#blobsDirectory, { mode: DIRECTORY_MODE, recursive: true }),
      mkdir(pipeline.#temporaryDirectory, { mode: DIRECTORY_MODE, recursive: true }),
    ]);
    await pipeline.#discardTemporaryFiles();
    return pipeline;
  }

  public get directory(): string {
    return this.#directory;
  }

  public async ingest(input: ArtifactIngestInput): Promise<ArtifactRecord> {
    const scope = artifactScopeSchema.parse(input.scope);
    const provenance = artifactProvenanceSchema.parse(input.provenance);
    const filename = normalizedFilename(input.filename);
    const temporaryPath = join(this.#temporaryDirectory, `${nanoid()}.part`);
    const file = await openFile(temporaryPath, 'wx', FILE_MODE);
    const hash = createHash('sha256');
    const prefix: Uint8Array[] = [];
    let prefixBytes = 0;
    let size = 0;
    let closed = false;

    try {
      for await (const chunk of chunksFrom(input.data)) {
        input.signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Artifact input yielded a value that was not bytes.');
        }
        if (chunk.byteLength === 0) continue;

        size += chunk.byteLength;
        if (size > this.#maxArtifactBytes) throw new ArtifactTooLargeError(this.#maxArtifactBytes);
        hash.update(chunk);

        if (prefixBytes < PROBE_BYTES) {
          const kept = chunk.slice(0, PROBE_BYTES - prefixBytes);
          prefix.push(kept);
          prefixBytes += kept.byteLength;
        }

        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten === 0) throw new Error('Artifact temporary file accepted zero bytes.');
          offset += bytesWritten;
        }
      }

      input.signal?.throwIfAborted();
      await file.sync();
      await file.close();
      closed = true;

      const blobHash = hash.digest('hex');
      const storageKey = posix.join('blobs', 'sha256', blobHash.slice(0, 2), blobHash);
      const blobPath = this.#pathForStorageKey(storageKey);
      await mkdir(join(this.#blobsDirectory, blobHash.slice(0, 2)), {
        mode: DIRECTORY_MODE,
        recursive: true,
      });
      await this.#commitBlob(temporaryPath, blobPath, size);

      const probe = probeArtifact(
        Buffer.concat(prefix.map((chunk) => Buffer.from(chunk))),
        input.declaredMediaType,
        filename,
      );
      const artifactId = `art_${nanoid()}`;
      const createdAt = Date.now();

      const record = await this.#database.transaction((database) => {
        database
          .insert(artifactBlobs)
          .values({ blobHash, createdAt, size, storageKey })
          .onConflictDoNothing({ target: artifactBlobs.blobHash })
          .run();

        const storedBlob = database
          .select()
          .from(artifactBlobs)
          .where(eq(artifactBlobs.blobHash, blobHash))
          .get();
        if (storedBlob?.size !== size) {
          throw new Error(`Stored size for artifact blob ${blobHash} is inconsistent.`);
        }
        if (storedBlob.storageKey !== storageKey) {
          throw new Error(`Stored path for artifact blob ${blobHash} is inconsistent.`);
        }

        const row = {
          artifactId,
          blobHash,
          createdAt,
          declaredMediaType: probe.declaredMediaType ?? null,
          detectedMediaType: probe.detectedMediaType ?? null,
          filename: filename ?? null,
          mediaType: probe.mediaType,
          provenance,
          scopeId: scope.id,
          scopeType: scope.type,
        };
        database.insert(artifacts).values(row).run();
        return freezeRecord({ ...row, size });
      });

      this.#logger.info(
        {
          artifactId,
          blobHash,
          deduplicated: await this.#artifactCountForBlob(blobHash).then((count) => count > 1),
          mediaType: record.mediaType,
          size,
        },
        'Artifact ingested.',
      );
      return record;
    } catch (error) {
      if (!closed) await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async find(
    artifactId: string,
    scope?: ArtifactScope,
  ): Promise<ArtifactRecord | undefined> {
    const row = await this.#database.exclusive((database) =>
      database
        .select({
          artifactId: artifacts.artifactId,
          blobHash: artifacts.blobHash,
          createdAt: artifacts.createdAt,
          declaredMediaType: artifacts.declaredMediaType,
          detectedMediaType: artifacts.detectedMediaType,
          filename: artifacts.filename,
          mediaType: artifacts.mediaType,
          provenance: artifacts.provenance,
          scopeId: artifacts.scopeId,
          scopeType: artifacts.scopeType,
          size: artifactBlobs.size,
        })
        .from(artifacts)
        .innerJoin(artifactBlobs, eq(artifacts.blobHash, artifactBlobs.blobHash))
        .where(eq(artifacts.artifactId, artifactId))
        .get(),
    );
    if (row === undefined) return undefined;

    const record = freezeRecord(row);
    return scope === undefined || sameScope(record.scope, scope) ? record : undefined;
  }

  public async ref(artifactId: string, scope?: ArtifactScope): Promise<ArtifactRef | undefined> {
    const record = await this.find(artifactId, scope);
    return record === undefined ? undefined : artifactRef(record);
  }

  public async open(artifactId: string, scope?: ArtifactScope): Promise<ArtifactPayload> {
    const artifact = await this.find(artifactId, scope);
    if (artifact === undefined) throw new ArtifactNotFoundError(artifactId);

    const blob = await this.#database.exclusive((database) =>
      database
        .select({ storageKey: artifactBlobs.storageKey })
        .from(artifactBlobs)
        .where(eq(artifactBlobs.blobHash, artifact.blobHash))
        .get(),
    );
    if (blob === undefined)
      throw new Error(`Artifact ${artifactId} references missing blob metadata.`);

    const file = Bun.file(this.#pathForStorageKey(blob.storageKey));
    if (!(await file.exists()))
      throw new Error(`Artifact ${artifactId} is missing its stored bytes.`);
    return Object.freeze({ artifact, stream: file.stream() });
  }

  async #artifactCountForBlob(blobHash: string): Promise<number> {
    return this.#database.exclusive(
      (database) =>
        database
          .select({ artifactId: artifacts.artifactId })
          .from(artifacts)
          .where(eq(artifacts.blobHash, blobHash))
          .all().length,
    );
  }

  async #commitBlob(temporaryPath: string, blobPath: string, size: number): Promise<void> {
    try {
      await link(temporaryPath, blobPath);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      const existing = await stat(blobPath);
      if (!existing.isFile() || existing.size !== size) {
        throw new Error(`Content-addressed artifact path ${blobPath} is inconsistent.`, {
          cause: error,
        });
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #discardTemporaryFiles(): Promise<void> {
    const glob = new Bun.Glob('*.part');
    let removed = 0;
    for await (const name of glob.scan({ cwd: this.#temporaryDirectory, onlyFiles: true })) {
      await rm(join(this.#temporaryDirectory, name), { force: true });
      removed += 1;
    }
    if (removed > 0) {
      this.#logger.warn({ removed }, 'Discarded interrupted artifact ingestions.');
    }
  }

  #pathForStorageKey(storageKey: string): string {
    return join(this.#directory, ...storageKey.split('/'));
  }
}

export { ArtifactPipeline, artifactRef, DEFAULT_MAX_ARTIFACT_BYTES };

export type { ArtifactPipelineOptions };
