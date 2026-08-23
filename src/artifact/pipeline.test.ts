import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../database/database';
import { artifactBlobs, artifacts } from '../database/schema';
import { ArtifactTooLargeError } from './error';
import { ArtifactPipeline } from './pipeline';

const directories: string[] = [];
const databases: Database[] = [];
const ACCOUNT = { id: 'account-1', type: 'account' as const };
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

async function pipeline(maxArtifactBytes?: number): Promise<ArtifactPipeline> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-artifacts-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  databases.push(database);
  return ArtifactPipeline.open({ dataDirectory: directory, database, maxArtifactBytes });
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
});
