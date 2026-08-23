import { createHash } from 'node:crypto';
import { link, mkdir, open as openFile, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { artifactBlobs, artifactRenditions, artifacts } from '../database/schema';
import { type Logger, silentLogger } from '../logger/logger';
import { stableStringify } from '../utils/json';
import { Mutex } from '../utils/mutex';
import {
  ArtifactNotFoundError,
  ArtifactProcessorDeterminismError,
  ArtifactProcessorOutputError,
  ArtifactRepresentationUnavailableError,
  ArtifactTooLargeError,
} from './error';
import { PROBE_BYTES, probeArtifact } from './probe';
import {
  type ArtifactProcessor,
  type ArtifactProcessorOutput,
  ArtifactProcessorRegistry,
  type ArtifactProcessorSource,
} from './processor';
import {
  type ArtifactOriginalRepresentation,
  type ArtifactRenditionRepresentation,
  type ArtifactResolvedPayload,
  normalizeRepresentationProfile,
  profileAcceptsMediaType,
  profileAcceptsOriginal,
  type RepresentationProfile,
  representationProfileDigest,
} from './representation';
import {
  type ArtifactByteSource,
  type ArtifactIngestInput,
  type ArtifactPayload,
  artifactProvenanceSchema,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactScope,
  artifactScopeSchema,
  mediaTypeSchema,
} from './types';

import type { Database, NoxDrizzle, NoxTransaction } from '../database/database';

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface ArtifactPipelineOptions {
  readonly dataDirectory: string;
  readonly database: Database;
  readonly logger?: Logger;
  readonly maxArtifactBytes?: number;
  readonly processorRegistry?: ArtifactProcessorRegistry;
}

interface ArtifactResolveOptions {
  readonly scope?: ArtifactScope;
  readonly signal?: AbortSignal;
}

interface StoredBlob {
  readonly blobHash: string;
  readonly createdAt: number;
  readonly prefix: Uint8Array;
  readonly size: number;
  readonly storageKey: string;
}

interface BlobWriteOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly tooLarge: () => Error;
  readonly validate?: (prefix: Uint8Array) => void;
}

interface RenditionCacheIdentity {
  readonly processorId: string;
  readonly processorVersion: string;
  readonly profileDigest: string;
  readonly sourceBlobHash: string;
  readonly sourceMediaType: string;
}

interface RenditionJoinedRow {
  readonly blobHash: string;
  readonly createdAt: number;
  readonly declaredMediaType: null | string;
  readonly detectedMediaType: null | string;
  readonly mediaType: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly profile: RepresentationProfile;
  readonly renditionId: string;
  readonly size: number;
  readonly sourceBlobHash: string;
  readonly sourceMediaType: string;
}

interface ResolutionLock {
  readonly mutex: Mutex;
  users: number;
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

function isReadableByteStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): source is ReadableStream<Uint8Array> {
  return 'getReader' in source && typeof source.getReader === 'function';
}

async function* chunksFrom(source: ArtifactByteSource): AsyncGenerator<Uint8Array> {
  const byteSource = source instanceof Blob ? source.stream() : source;
  if (isReadableByteStream(byteSource)) {
    const reader = byteSource.getReader();
    let completed = false;
    try {
      let result = await reader.read();
      while (!result.done) {
        yield result.value;
        result = await reader.read();
      }
      completed = true;
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the consumer error that interrupted the stream.
        }
      }
      // Bun request-body readers do not consistently expose `releaseLock`.
      // The source is complete or cancelled here and is never reused.
    }
    return;
  }

  for await (const chunk of byteSource) yield chunk;
}

async function* processorChunks(
  source: ArtifactByteSource,
  processorId: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of chunksFrom(source)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ArtifactProcessorOutputError(processorId, 'emitted a value that was not bytes.');
      }
      yield chunk;
    }
  } catch (error) {
    if (signal?.aborted === true || error instanceof ArtifactProcessorOutputError) throw error;
    throw new ArtifactProcessorOutputError(processorId, 'failed while producing bytes.', {
      cause: error,
    });
  }
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

function freezeRendition(
  row: RenditionJoinedRow,
  profile: RepresentationProfile,
): ArtifactRenditionRepresentation {
  return Object.freeze({
    blobHash: row.blobHash,
    createdAt: row.createdAt,
    ...(row.declaredMediaType === null ? {} : { declaredMediaType: row.declaredMediaType }),
    ...(row.detectedMediaType === null ? {} : { detectedMediaType: row.detectedMediaType }),
    mediaType: row.mediaType,
    processor: Object.freeze({ id: row.processorId, version: row.processorVersion }),
    profile,
    renditionId: row.renditionId,
    size: row.size,
    sourceBlobHash: row.sourceBlobHash,
    sourceMediaType: row.sourceMediaType,
    type: 'rendition',
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

function cacheWhere(identity: RenditionCacheIdentity): ReturnType<typeof and> {
  return and(
    eq(artifactRenditions.sourceBlobHash, identity.sourceBlobHash),
    eq(artifactRenditions.sourceMediaType, identity.sourceMediaType),
    eq(artifactRenditions.profileDigest, identity.profileDigest),
    eq(artifactRenditions.processorId, identity.processorId),
    eq(artifactRenditions.processorVersion, identity.processorVersion),
  );
}

/**
 * The one door through which durable bytes enter Nox. It owns physical layout,
 * hashing and logical metadata; callers retain only an artifact reference.
 * Deterministic processors may add regenerable renditions of those same bytes.
 */
class ArtifactPipeline {
  readonly #blobsDirectory: string;
  readonly #database: Database;
  readonly #directory: string;
  readonly #logger: Logger;
  readonly #maxArtifactBytes: number;
  readonly #processors: ArtifactProcessorRegistry;
  readonly #resolutionLocks = new Map<string, ResolutionLock>();
  readonly #temporaryDirectory: string;

  private constructor(options: ArtifactPipelineOptions) {
    this.#directory = join(options.dataDirectory, 'artifacts');
    this.#blobsDirectory = join(this.#directory, 'blobs', 'sha256');
    this.#temporaryDirectory = join(this.#directory, 'tmp');
    this.#database = options.database;
    this.#logger = options.logger ?? silentLogger;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#processors = options.processorRegistry ?? new ArtifactProcessorRegistry();
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

  public get processors(): ArtifactProcessorRegistry {
    return this.#processors;
  }

  public async ingest(input: ArtifactIngestInput): Promise<ArtifactRecord> {
    const scope = artifactScopeSchema.parse(input.scope);
    const provenance = artifactProvenanceSchema.parse(input.provenance);
    const filename = normalizedFilename(input.filename);
    const blob = await this.#writeBlob(input.data, {
      maxBytes: this.#maxArtifactBytes,
      signal: input.signal,
      tooLarge: () => new ArtifactTooLargeError(this.#maxArtifactBytes),
    });
    const probe = probeArtifact(blob.prefix, input.declaredMediaType, filename);
    const artifactId = `art_${nanoid()}`;
    const createdAt = Date.now();

    const record = await this.#database.transaction((database) => {
      this.#recordBlob(database, blob);
      const row = {
        artifactId,
        blobHash: blob.blobHash,
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
      return freezeRecord({ ...row, size: blob.size });
    });

    this.#logger.info(
      {
        artifactId,
        blobHash: blob.blobHash,
        deduplicated: await this.#artifactCountForBlob(blob.blobHash).then((count) => count > 1),
        mediaType: record.mediaType,
        size: blob.size,
      },
      'Artifact ingested.',
    );
    return record;
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
    return Object.freeze({
      artifact,
      stream: await this.#openBlob(artifact.blobHash, `artifact ${artifactId}`),
    });
  }

  public async resolve(
    artifactId: string,
    requestedProfile: RepresentationProfile,
    options: ArtifactResolveOptions = {},
  ): Promise<ArtifactResolvedPayload> {
    const profile = normalizeRepresentationProfile(requestedProfile);
    const artifact = await this.find(artifactId, options.scope);
    if (artifact === undefined) throw new ArtifactNotFoundError(artifactId);
    options.signal?.throwIfAborted();

    if (profileAcceptsOriginal(profile, artifact)) {
      const representation: ArtifactOriginalRepresentation = Object.freeze({
        blobHash: artifact.blobHash,
        mediaType: artifact.mediaType,
        size: artifact.size,
        type: 'original',
      });
      return Object.freeze({
        artifact,
        representation,
        stream: await this.#openBlob(artifact.blobHash, `artifact ${artifactId}`),
      });
    }

    const source: ArtifactProcessorSource = Object.freeze({
      blobHash: artifact.blobHash,
      mediaType: artifact.mediaType,
      size: artifact.size,
    });
    const processor = this.#processors.select(source, profile);
    if (processor === undefined) {
      throw new ArtifactRepresentationUnavailableError(artifactId, profile.id, artifact.mediaType);
    }

    const identity = Object.freeze({
      processorId: processor.id,
      processorVersion: processor.version,
      profileDigest: representationProfileDigest(profile),
      sourceBlobHash: artifact.blobHash,
      sourceMediaType: artifact.mediaType,
    });
    const lockKey = stableStringify(identity);
    const representation = await this.#withResolutionLock(lockKey, async () => {
      options.signal?.throwIfAborted();
      const cached = await this.#findCachedRendition(identity, profile);
      if (cached !== undefined) return cached;
      return this.#createRendition(artifact, source, profile, processor, identity, options.signal);
    });

    return Object.freeze({
      artifact,
      representation,
      stream: await this.#openBlob(
        representation.blobHash,
        `rendition ${representation.renditionId}`,
      ),
    });
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

  async #createRendition(
    artifact: ArtifactRecord,
    source: ArtifactProcessorSource,
    profile: RepresentationProfile,
    processor: ArtifactProcessor,
    identity: RenditionCacheIdentity,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactRenditionRepresentation> {
    const sourceStream = await this.#openBlob(
      artifact.blobHash,
      `source artifact ${artifact.artifactId}`,
    );
    let uncheckedOutput: unknown;
    try {
      uncheckedOutput = await processor.process({
        profile,
        ...(signal === undefined ? {} : { signal }),
        source: Object.freeze({ ...source, stream: sourceStream }),
      });
    } catch (error) {
      if (signal?.aborted === true || error instanceof ArtifactProcessorOutputError) throw error;
      throw new ArtifactProcessorOutputError(processor.id, 'failed before producing bytes.', {
        cause: error,
      });
    }
    if (
      typeof uncheckedOutput !== 'object' ||
      uncheckedOutput === null ||
      !('data' in uncheckedOutput) ||
      !('mediaType' in uncheckedOutput)
    ) {
      throw new ArtifactProcessorOutputError(processor.id, 'returned no byte source.');
    }
    const output = uncheckedOutput as ArtifactProcessorOutput;

    const parsedMediaType = mediaTypeSchema.safeParse(output.mediaType);
    if (!parsedMediaType.success) {
      throw new ArtifactProcessorOutputError(processor.id, 'returned an invalid media type.', {
        cause: parsedMediaType.error,
      });
    }

    const maxBytes = Math.min(profile.maxBytes ?? this.#maxArtifactBytes, this.#maxArtifactBytes);
    const blob = await this.#writeBlob(processorChunks(output.data, processor.id, signal), {
      maxBytes,
      ...(signal === undefined ? {} : { signal }),
      tooLarge: () =>
        new ArtifactProcessorOutputError(
          processor.id,
          `exceeded the ${String(maxBytes)} byte representation limit.`,
        ),
      validate: (prefix) => {
        const inspected = probeArtifact(prefix, parsedMediaType.data, undefined);
        if (!profileAcceptsMediaType(profile, inspected.mediaType)) {
          throw new ArtifactProcessorOutputError(
            processor.id,
            `returned ${inspected.mediaType}, which profile "${profile.id}" does not accept.`,
          );
        }
      },
    });
    const probe = probeArtifact(blob.prefix, parsedMediaType.data, undefined);

    const renditionId = `rnd_${nanoid()}`;
    const createdAt = Date.now();
    const rendition = await this.#database.transaction((database) => {
      this.#recordBlob(database, blob);
      database
        .insert(artifactRenditions)
        .values({
          renditionId,
          blobHash: blob.blobHash,
          createdAt,
          declaredMediaType: probe.declaredMediaType ?? null,
          detectedMediaType: probe.detectedMediaType ?? null,
          mediaType: probe.mediaType,
          processorId: identity.processorId,
          processorVersion: identity.processorVersion,
          profile,
          profileDigest: identity.profileDigest,
          profileId: profile.id,
          profileVersion: profile.version,
          sourceBlobHash: identity.sourceBlobHash,
          sourceMediaType: identity.sourceMediaType,
        })
        .onConflictDoNothing({
          target: [
            artifactRenditions.sourceBlobHash,
            artifactRenditions.sourceMediaType,
            artifactRenditions.profileDigest,
            artifactRenditions.processorId,
            artifactRenditions.processorVersion,
          ],
        })
        .run();

      const stored = this.#selectRendition(database, identity);
      if (stored === undefined)
        throw new Error('A persisted artifact rendition could not be read.');
      const deterministic =
        stored.blobHash === blob.blobHash &&
        stored.declaredMediaType === (probe.declaredMediaType ?? null) &&
        stored.detectedMediaType === (probe.detectedMediaType ?? null) &&
        stored.mediaType === probe.mediaType &&
        stableStringify(stored.profile) === stableStringify(profile);
      if (!deterministic) {
        throw new ArtifactProcessorDeterminismError(processor.id, processor.version);
      }
      return freezeRendition(stored, profile);
    });

    this.#logger.info(
      {
        artifactId: artifact.artifactId,
        blobHash: rendition.blobHash,
        mediaType: rendition.mediaType,
        processorId: processor.id,
        processorVersion: processor.version,
        profileId: profile.id,
        renditionId: rendition.renditionId,
        size: rendition.size,
      },
      'Artifact rendition resolved.',
    );
    return rendition;
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

  async #findCachedRendition(
    identity: RenditionCacheIdentity,
    profile: RepresentationProfile,
  ): Promise<ArtifactRenditionRepresentation | undefined> {
    const row = await this.#database.exclusive((database) =>
      this.#selectRendition(database, identity),
    );
    if (row === undefined) return undefined;
    if (stableStringify(row.profile) !== stableStringify(profile)) {
      throw new Error(
        `Artifact rendition profile digest ${identity.profileDigest} is inconsistent.`,
      );
    }
    if (
      !profileAcceptsMediaType(profile, row.mediaType) ||
      (profile.maxBytes !== undefined && row.size > profile.maxBytes)
    ) {
      throw new Error(`Cached artifact rendition ${row.renditionId} violates its profile.`);
    }
    return freezeRendition(row, profile);
  }

  async #openBlob(blobHash: string, subject: string): Promise<ReadableStream<Uint8Array>> {
    const blob = await this.#database.exclusive((database) =>
      database
        .select({ storageKey: artifactBlobs.storageKey })
        .from(artifactBlobs)
        .where(eq(artifactBlobs.blobHash, blobHash))
        .get(),
    );
    if (blob === undefined) throw new Error(`${subject} references missing blob metadata.`);

    const file = Bun.file(this.#pathForStorageKey(blob.storageKey));
    if (!(await file.exists())) throw new Error(`${subject} is missing its stored bytes.`);
    return file.stream();
  }

  #pathForStorageKey(storageKey: string): string {
    return join(this.#directory, ...storageKey.split('/'));
  }

  #recordBlob(database: NoxTransaction, blob: StoredBlob): void {
    database
      .insert(artifactBlobs)
      .values({
        blobHash: blob.blobHash,
        createdAt: blob.createdAt,
        size: blob.size,
        storageKey: blob.storageKey,
      })
      .onConflictDoNothing({ target: artifactBlobs.blobHash })
      .run();

    const storedBlob = database
      .select()
      .from(artifactBlobs)
      .where(eq(artifactBlobs.blobHash, blob.blobHash))
      .get();
    if (storedBlob?.size !== blob.size) {
      throw new Error(`Stored size for artifact blob ${blob.blobHash} is inconsistent.`);
    }
    if (storedBlob.storageKey !== blob.storageKey) {
      throw new Error(`Stored path for artifact blob ${blob.blobHash} is inconsistent.`);
    }
  }

  #selectRendition(
    database: NoxDrizzle | NoxTransaction,
    identity: RenditionCacheIdentity,
  ): RenditionJoinedRow | undefined {
    return database
      .select({
        blobHash: artifactRenditions.blobHash,
        createdAt: artifactRenditions.createdAt,
        declaredMediaType: artifactRenditions.declaredMediaType,
        detectedMediaType: artifactRenditions.detectedMediaType,
        mediaType: artifactRenditions.mediaType,
        processorId: artifactRenditions.processorId,
        processorVersion: artifactRenditions.processorVersion,
        profile: artifactRenditions.profile,
        renditionId: artifactRenditions.renditionId,
        size: artifactBlobs.size,
        sourceBlobHash: artifactRenditions.sourceBlobHash,
        sourceMediaType: artifactRenditions.sourceMediaType,
      })
      .from(artifactRenditions)
      .innerJoin(artifactBlobs, eq(artifactRenditions.blobHash, artifactBlobs.blobHash))
      .where(cacheWhere(identity))
      .get();
  }

  async #withResolutionLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lock = this.#resolutionLocks.get(key);
    if (lock === undefined) {
      lock = { mutex: new Mutex(), users: 0 };
      this.#resolutionLocks.set(key, lock);
    }
    lock.users += 1;

    try {
      return await lock.mutex.run(task);
    } finally {
      lock.users -= 1;
      if (lock.users === 0 && this.#resolutionLocks.get(key) === lock) {
        this.#resolutionLocks.delete(key);
      }
    }
  }

  async #writeBlob(data: ArtifactByteSource, options: BlobWriteOptions): Promise<StoredBlob> {
    const temporaryPath = join(this.#temporaryDirectory, `${nanoid()}.part`);
    const file = await openFile(temporaryPath, 'wx', FILE_MODE);
    const hash = createHash('sha256');
    const prefix: Uint8Array[] = [];
    let prefixBytes = 0;
    let size = 0;
    let closed = false;

    try {
      for await (const chunk of chunksFrom(data)) {
        options.signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Artifact byte source yielded a value that was not bytes.');
        }
        if (chunk.byteLength === 0) continue;

        size += chunk.byteLength;
        if (size > options.maxBytes) throw options.tooLarge();
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

      options.signal?.throwIfAborted();
      await file.sync();
      await file.close();
      closed = true;

      const prefixBuffer = Buffer.concat(prefix.map((chunk) => Buffer.from(chunk)));
      options.validate?.(prefixBuffer);
      const blobHash = hash.digest('hex');
      const storageKey = posix.join('blobs', 'sha256', blobHash.slice(0, 2), blobHash);
      const blobPath = this.#pathForStorageKey(storageKey);
      await mkdir(join(this.#blobsDirectory, blobHash.slice(0, 2)), {
        mode: DIRECTORY_MODE,
        recursive: true,
      });
      await this.#commitBlob(temporaryPath, blobPath, size);
      return Object.freeze({
        blobHash,
        createdAt: Date.now(),
        prefix: prefixBuffer,
        size,
        storageKey,
      });
    } catch (error) {
      if (!closed) await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export { ArtifactPipeline, artifactRef, DEFAULT_MAX_ARTIFACT_BYTES };

export type { ArtifactPipelineOptions, ArtifactResolveOptions };
