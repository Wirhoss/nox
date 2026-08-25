import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../database/database';
import { artifactBlobs, artifactRenditions, artifacts } from '../database/schema';
import {
  ArtifactProcessorDeterminismError,
  ArtifactProcessorOutputError,
  ArtifactRepresentationUnavailableError,
  ArtifactStorageQuotaError,
  ArtifactTooLargeError,
} from './error';
import { ArtifactPipeline } from './pipeline';
import { type ArtifactProcessor, ArtifactProcessorRegistry } from './processor';

import type { RepresentationProfile } from './representation';

const directories: string[] = [];
const databases: Database[] = [];
const ACCOUNT = { id: 'account-1', type: 'account' as const };
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

async function pipeline(
  maxArtifactBytes?: number,
  processorRegistry?: ArtifactProcessorRegistry,
  maxStorageBytes?: number,
): Promise<ArtifactPipeline> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-artifacts-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  databases.push(database);
  return ArtifactPipeline.open({
    dataDirectory: directory,
    database,
    maxArtifactBytes,
    maxStorageBytes,
    processorRegistry,
  });
}

function upload(
  data: Blob | Uint8Array = PNG,
  overrides: Partial<Parameters<ArtifactPipeline['ingest']>[0]> = {},
) {
  return {
    data: data instanceof Blob ? data : new Blob([data]),
    declaredMediaType: 'image/png',
    filename: 'image.png',
    provenance: { type: 'upload' as const },
    scope: ACCOUNT,
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function profile(overrides: Partial<RepresentationProfile> = {}): RepresentationProfile {
  return {
    id: 'test.consumer',
    mediaTypes: ['text/plain'],
    transform: { format: 'plain' },
    version: 1,
    ...overrides,
  };
}

function processor(
  process: ArtifactProcessor['process'],
  overrides: Partial<ArtifactProcessor> = {},
): ArtifactProcessor {
  return {
    id: 'test.convert',
    process,
    supports: () => true,
    version: '1',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* Windows may briefly retain a SQLite handle. */
    }
  }
});

describe('ArtifactPipeline', () => {
  test('streams bytes into content-addressed storage and records logical metadata', async () => {
    const artifactsPipeline = await pipeline();
    const artifact = await artifactsPipeline.ingest(
      upload(PNG, { filename: '../../screenshots\\diagram.png' }),
    );
    const hash = sha256(PNG);

    expect(artifact.artifactId).toMatch(/^art_/);
    expect(artifact).toMatchObject({
      blobHash: hash,
      declaredMediaType: 'image/png',
      detectedMediaType: 'image/png',
      filename: 'diagram.png',
      mediaType: 'image/png',
      provenance: { type: 'upload' },
      scope: ACCOUNT,
      size: PNG.byteLength,
    });
    expect(
      existsSync(join(artifactsPipeline.directory, 'blobs', 'sha256', hash.slice(0, 2), hash)),
    ).toBeTrue();
    const payload = await artifactsPipeline.open(artifact.artifactId);
    expect(new Uint8Array(await new Response(payload.stream).arrayBuffer())).toEqual(PNG);
  });

  test('reads web streams through their reader rather than the native async iterator', async () => {
    const artifactsPipeline = await pipeline();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG.slice(0, 5));
        controller.enqueue(PNG.slice(5));
        controller.close();
      },
    });
    const source = {
      getReader: () => {
        const reader = stream.getReader();
        return {
          cancel: () => reader.cancel(),
          read: () => reader.read(),
        } as ReadableStreamDefaultReader<Uint8Array>;
      },
      [Symbol.asyncIterator]: () => {
        throw new Error('The native async iterator must not be used.');
      },
    } as unknown as ReadableStream<Uint8Array>;

    const artifact = await artifactsPipeline.ingest(upload(PNG, { data: source }));

    expect(artifact.blobHash).toBe(sha256(PNG));
    expect(artifact.size).toBe(PNG.byteLength);
  });

  test('deduplicates physical bytes without collapsing artifact identity or provenance', async () => {
    const artifactsPipeline = await pipeline();
    const [first, second] = await Promise.all([
      artifactsPipeline.ingest(upload(PNG, { filename: 'first.png' })),
      artifactsPipeline.ingest(
        upload(PNG, {
          filename: 'second.png',
          provenance: { details: { trackId: 'track-2' }, type: 'tool' },
        }),
      ),
    ]);

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(first.blobHash).toBe(second.blobHash);
    expect(first.filename).toBe('first.png');
    expect(second.filename).toBe('second.png');

    const database = databases[0];
    expect(await database?.db.select().from(artifactBlobs)).toHaveLength(1);
    expect(await database?.db.select().from(artifacts)).toHaveLength(2);
  });

  test('keeps access scoped even when the caller knows an artifact ID', async () => {
    const artifactsPipeline = await pipeline();
    const artifact = await artifactsPipeline.ingest(upload());

    expect(await artifactsPipeline.ref(artifact.artifactId, ACCOUNT)).toEqual({
      artifactId: artifact.artifactId,
      filename: 'image.png',
      mediaType: 'image/png',
      size: PNG.byteLength,
    });
    expect(
      await artifactsPipeline.ref(artifact.artifactId, { id: 'account-2', type: 'account' }),
    ).toBeUndefined();
    expect(
      artifactsPipeline.open(artifact.artifactId, { id: 'account-2', type: 'account' }),
    ).rejects.toThrow(/outside this scope/);
  });

  test('preserves a specific ZIP container format while recording what magic bytes proved', async () => {
    const artifactsPipeline = await pipeline();
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const artifact = await artifactsPipeline.ingest(
      upload(zip, {
        declaredMediaType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary',
        filename: 'book.xlsx',
      }),
    );

    expect(artifact.detectedMediaType).toBe('application/zip');
    expect(artifact.mediaType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  test('rejects oversized input, removes the temporary and writes no metadata', async () => {
    const artifactsPipeline = await pipeline(4);

    expect(artifactsPipeline.ingest(upload(new Uint8Array(5)))).rejects.toBeInstanceOf(
      ArtifactTooLargeError,
    );
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    const database = databases[0];
    expect(await database?.db.select().from(artifactBlobs)).toEqual([]);
    expect(await database?.db.select().from(artifacts)).toEqual([]);
  });

  test('counts unique physical bytes against the storage quota', async () => {
    const artifactsPipeline = await pipeline(PNG.byteLength, undefined, PNG.byteLength);
    const first = await artifactsPipeline.ingest(upload(PNG, { filename: 'first.png' }));
    const duplicate = await artifactsPipeline.ingest(upload(PNG, { filename: 'duplicate.png' }));

    expect(duplicate.blobHash).toBe(first.blobHash);
    expect(
      artifactsPipeline.ingest(
        upload(Uint8Array.from([...PNG.slice(0, -1), 0xff]), { filename: 'different.png' }),
      ),
    ).rejects.toBeInstanceOf(ArtifactStorageQuotaError);
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    const database = databases[0];
    expect(await database?.db.select().from(artifactBlobs)).toHaveLength(1);
    expect(await database?.db.select().from(artifacts)).toHaveLength(2);
  });

  test('serializes concurrent quota decisions across pipelines sharing one database', async () => {
    const artifactsPipeline = await pipeline(PNG.byteLength, undefined, PNG.byteLength);
    const database = databases[0];
    if (database === undefined) throw new Error('Expected a test database.');
    const secondPipeline = await ArtifactPipeline.open({
      dataDirectory: dirname(artifactsPipeline.directory),
      database,
      maxArtifactBytes: PNG.byteLength,
      maxStorageBytes: PNG.byteLength,
    });
    const different = Uint8Array.from([...PNG.slice(0, -1), 0xff]);

    const results = await Promise.allSettled([
      artifactsPipeline.ingest(upload(PNG, { filename: 'first.png' })),
      secondPipeline.ingest(upload(different, { filename: 'second.png' })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      ArtifactStorageQuotaError,
    );
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    expect(await database.db.select().from(artifactBlobs)).toHaveLength(1);
    expect(await database.db.select().from(artifacts)).toHaveLength(1);
  });

  test('applies the storage quota to lazy rendition bytes too', async () => {
    const registry = new ArtifactProcessorRegistry([
      processor(() => ({ data: new Blob(['rendered']), mediaType: 'text/plain' })),
    ]);
    const artifactsPipeline = await pipeline(8, registry, 8);
    const source = await artifactsPipeline.ingest(
      upload(new Blob(['source']), {
        declaredMediaType: 'application/octet-stream',
        filename: 'source.bin',
      }),
    );

    expect(artifactsPipeline.resolve(source.artifactId, profile())).rejects.toBeInstanceOf(
      ArtifactStorageQuotaError,
    );
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    const database = databases[0];
    expect(await database?.db.select().from(artifactBlobs)).toHaveLength(1);
    expect(await database?.db.select().from(artifactRenditions)).toEqual([]);
  });

  test('cleans interrupted temporary writes when it opens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-artifacts-'));
    directories.push(directory);
    const temporaryDirectory = join(directory, 'artifacts', 'tmp');
    mkdirSync(temporaryDirectory, { recursive: true });
    writeFileSync(join(directory, 'placeholder'), 'keeps parent around');
    await Bun.write(join(temporaryDirectory, 'interrupted.part'), 'partial');
    await Bun.write(join(temporaryDirectory, 'leave-me.txt'), 'not owned by ingestion');
    const database = await Database.open({ path: join(directory, 'nox.db') });
    databases.push(database);

    await ArtifactPipeline.open({ dataDirectory: directory, database });

    expect(readdirSync(temporaryDirectory)).toEqual(['leave-me.txt']);
  });

  test('reconciles final blobs left without committed metadata on startup', async () => {
    const artifactsPipeline = await pipeline();
    const stored = await artifactsPipeline.ingest(upload());
    const orphan = new TextEncoder().encode('transaction never committed');
    const orphanHash = sha256(orphan);
    const orphanDirectory = join(
      artifactsPipeline.directory,
      'blobs',
      'sha256',
      orphanHash.slice(0, 2),
    );
    const orphanPath = join(orphanDirectory, orphanHash);
    mkdirSync(orphanDirectory, { recursive: true });
    writeFileSync(orphanPath, orphan);
    const database = databases[0];
    if (database === undefined) throw new Error('Expected a test database.');

    await ArtifactPipeline.open({
      dataDirectory: dirname(artifactsPipeline.directory),
      database,
    });

    expect(existsSync(orphanPath)).toBeFalse();
    expect(
      existsSync(
        join(
          artifactsPipeline.directory,
          'blobs',
          'sha256',
          stored.blobHash.slice(0, 2),
          stored.blobHash,
        ),
      ),
    ).toBeTrue();
  });

  test('resolves the immutable original when it already satisfies the profile', async () => {
    const artifactsPipeline = await pipeline();
    const artifact = await artifactsPipeline.ingest(upload());
    const resolved = await artifactsPipeline.resolve(
      artifact.artifactId,
      profile({ mediaTypes: ['image/*'], transform: undefined }),
      { scope: ACCOUNT },
    );

    expect(resolved.artifact).toEqual(artifact);
    expect(resolved.representation).toEqual({
      blobHash: artifact.blobHash,
      mediaType: 'image/png',
      size: PNG.byteLength,
      type: 'original',
    });
    expect(new Uint8Array(await new Response(resolved.stream).arrayBuffer())).toEqual(PNG);
    expect(await databases[0]?.db.select().from(artifactRenditions)).toEqual([]);
  });

  test('creates one deterministic rendition and reuses it across concurrent resolutions', async () => {
    let calls = 0;
    const registry = new ArtifactProcessorRegistry([
      processor(async ({ source }) => {
        calls += 1;
        await Bun.sleep(5);
        const input = new Uint8Array(await new Response(source.stream).arrayBuffer());
        return {
          data: new Blob([`source bytes: ${String(input.byteLength)}`]),
          mediaType: 'text/plain',
        };
      }),
    ]);
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());
    const requested = profile({ transform: { quality: 80, width: 512 } });

    const resolved = await Promise.all(
      Array.from({ length: 8 }, async () =>
        artifactsPipeline.resolve(artifact.artifactId, requested, { scope: ACCOUNT }),
      ),
    );

    expect(calls).toBe(1);
    expect(new Set(resolved.map((entry) => entry.representation.blobHash))).toHaveLength(1);
    expect(new Set(resolved.map((entry) => entry.representation.type))).toEqual(
      new Set(['rendition']),
    );
    const renditionIds = resolved.flatMap((entry) =>
      entry.representation.type === 'rendition' ? [entry.representation.renditionId] : [],
    );
    expect(new Set(renditionIds)).toHaveLength(1);
    expect(await databases[0]?.db.select().from(artifactRenditions)).toHaveLength(1);
    expect(await databases[0]?.db.select().from(artifactBlobs)).toHaveLength(2);
  });

  test('canonicalizes profiles so parameter order cannot fragment the cache', async () => {
    let calls = 0;
    const registry = new ArtifactProcessorRegistry([
      processor(() => {
        calls += 1;
        return { data: new Blob(['plain']), mediaType: 'text/plain' };
      }),
    ]);
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());

    const first = await artifactsPipeline.resolve(
      artifact.artifactId,
      profile({ transform: { quality: 80, width: 512 } }),
    );
    const second = await artifactsPipeline.resolve(
      artifact.artifactId,
      profile({ transform: { width: 512, quality: 80 } }),
    );

    expect(calls).toBe(1);
    expect(first.representation).toEqual(second.representation);
  });

  test('reuses persisted renditions after the pipeline is reopened', async () => {
    let firstCalls = 0;
    const artifactsPipeline = await pipeline(
      undefined,
      new ArtifactProcessorRegistry([
        processor(() => {
          firstCalls += 1;
          return { data: new Blob(['persisted']), mediaType: 'text/plain' };
        }),
      ]),
    );
    const artifact = await artifactsPipeline.ingest(upload());
    const first = await artifactsPipeline.resolve(artifact.artifactId, profile());
    let reopenedCalls = 0;
    const database = databases[0];
    if (database === undefined) throw new Error('Expected a test database.');
    const reopened = await ArtifactPipeline.open({
      dataDirectory: dirname(artifactsPipeline.directory),
      database,
      processorRegistry: new ArtifactProcessorRegistry([
        processor(() => {
          reopenedCalls += 1;
          return { data: new Blob(['should not run']), mediaType: 'text/plain' };
        }),
      ]),
    });

    const second = await reopened.resolve(artifact.artifactId, profile());

    expect(firstCalls).toBe(1);
    expect(reopenedCalls).toBe(0);
    expect(second.representation).toEqual(first.representation);
  });

  test('processor versions invalidate only the rendition cache entry', async () => {
    const registry = new ArtifactProcessorRegistry();
    const unregister = registry.register(
      processor(() => ({ data: new Blob(['version 1']), mediaType: 'text/plain' })),
    );
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());
    const first = await artifactsPipeline.resolve(artifact.artifactId, profile());

    unregister.dispose();
    registry.register(
      processor(() => ({ data: new Blob(['version 2']), mediaType: 'text/plain' }), {
        version: '2',
      }),
    );
    const second = await artifactsPipeline.resolve(artifact.artifactId, profile());

    expect(first.representation.type).toBe('rendition');
    expect(second.representation.type).toBe('rendition');
    expect(first.representation.blobHash).not.toBe(second.representation.blobHash);
    expect(await databases[0]?.db.select().from(artifactRenditions)).toHaveLength(2);
    expect(await databases[0]?.db.select().from(artifacts)).toHaveLength(1);
  });

  test('fails explicitly when no registered processor can satisfy a profile', async () => {
    const artifactsPipeline = await pipeline();
    const artifact = await artifactsPipeline.ingest(upload());

    expect(artifactsPipeline.resolve(artifact.artifactId, profile())).rejects.toBeInstanceOf(
      ArtifactRepresentationUnavailableError,
    );
  });

  test('rejects oversized processor output without recording partial metadata', async () => {
    const registry = new ArtifactProcessorRegistry([
      processor(() => ({ data: new Blob(['12345']), mediaType: 'text/plain' })),
    ]);
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());

    expect(
      artifactsPipeline.resolve(artifact.artifactId, profile({ maxBytes: 4 })),
    ).rejects.toBeInstanceOf(ArtifactProcessorOutputError);
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    expect(await databases[0]?.db.select().from(artifactRenditions)).toEqual([]);
    expect(await databases[0]?.db.select().from(artifactBlobs)).toHaveLength(1);
  });

  test('attributes a failing output stream to the processor contract', async () => {
    const registry = new ArtifactProcessorRegistry([
      processor(() => ({
        data: (async function* brokenOutput() {
          await Promise.resolve();
          yield Uint8Array.of(0x01);
          throw new Error('decoder failed');
        })(),
        mediaType: 'text/plain',
      })),
    ]);
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());

    expect(artifactsPipeline.resolve(artifact.artifactId, profile())).rejects.toBeInstanceOf(
      ArtifactProcessorOutputError,
    );
    expect(readdirSync(join(artifactsPipeline.directory, 'tmp'))).toEqual([]);
    expect(await databases[0]?.db.select().from(artifactRenditions)).toEqual([]);
  });

  test('probes processor output before committing an incompatible blob', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
    const registry = new ArtifactProcessorRegistry([
      processor(() => ({ data: new Blob([jpeg]), mediaType: 'text/plain' })),
    ]);
    const artifactsPipeline = await pipeline(undefined, registry);
    const artifact = await artifactsPipeline.ingest(upload());
    const outputHash = sha256(jpeg);

    expect(artifactsPipeline.resolve(artifact.artifactId, profile())).rejects.toBeInstanceOf(
      ArtifactProcessorOutputError,
    );
    expect(
      existsSync(
        join(artifactsPipeline.directory, 'blobs', 'sha256', outputHash.slice(0, 2), outputHash),
      ),
    ).toBeFalse();
    expect(await databases[0]?.db.select().from(artifactRenditions)).toEqual([]);
  });

  test('detects a processor that violates its deterministic version contract', async () => {
    const artifactsPipeline = await pipeline();
    const database = databases[0];
    if (database === undefined) throw new Error('Expected a test database.');
    const artifact = await artifactsPipeline.ingest(upload());
    let arrivals = 0;
    let release: (() => void) | undefined;
    const rendezvous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitingProcessor = (output: string): ArtifactProcessor =>
      processor(async () => {
        arrivals += 1;
        if (arrivals === 2) release?.();
        await rendezvous;
        return { data: new Blob([output]), mediaType: 'text/plain' };
      });
    const firstPipeline = await ArtifactPipeline.open({
      dataDirectory: dirname(artifactsPipeline.directory),
      database,
      processorRegistry: new ArtifactProcessorRegistry([waitingProcessor('first')]),
    });
    const secondPipeline = await ArtifactPipeline.open({
      dataDirectory: dirname(artifactsPipeline.directory),
      database,
      processorRegistry: new ArtifactProcessorRegistry([waitingProcessor('second')]),
    });

    const results = await Promise.allSettled([
      firstPipeline.resolve(artifact.artifactId, profile()),
      secondPipeline.resolve(artifact.artifactId, profile()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      ArtifactProcessorDeterminismError,
    );
    expect(await database.db.select().from(artifactRenditions)).toHaveLength(1);
    expect(await database.db.select().from(artifactBlobs)).toHaveLength(2);
  });
});
