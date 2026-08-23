import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { Database } from '../database/database';
import { artifactConversationScope, ArtifactOutputSink } from './output';
import { ArtifactPipeline } from './pipeline';

let database: Database;
let directory: string;
let pipeline: ArtifactPipeline;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'nox-artifact-output-'));
  database = await Database.open({ path: join(directory, 'nox.db') });
  pipeline = await ArtifactPipeline.open({ dataDirectory: directory, database });
});

afterEach(async () => {
  await database.close();
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // Windows may briefly retain a SQLite handle.
  }
});

describe('ArtifactOutputSink', () => {
  test('binds streamed provider output to host-owned scope and provenance', async () => {
    const scope = artifactConversationScope('web', 'conversation-1');
    const publisher = new ArtifactOutputSink(pipeline, scope).publisher({
      details: { modelId: 'image-model', runId: 'run-1' },
      type: 'provider',
    });

    const part = await publisher.publish({
      data: new Blob(['generated file']),
      declaredMediaType: 'text/plain',
      filename: '../answer.txt',
    });
    const stored = await pipeline.find(part.artifact.artifactId, scope);
    if (stored === undefined) throw new Error('Published artifact was not stored.');

    expect(part).toEqual({
      artifact: {
        artifactId: stored.artifactId,
        filename: 'answer.txt',
        mediaType: 'text/plain',
        size: 14,
      },
      type: 'artifact',
    });
    expect(stored.provenance).toEqual({
      details: { modelId: 'image-model', runId: 'run-1' },
      type: 'provider',
    });
    expect(stored.scope).toEqual(scope);
    expect(await new ArtifactOutputSink(pipeline, scope).reference(stored.artifactId)).toEqual(
      part,
    );
    expect(
      await new ArtifactOutputSink(pipeline, artifactConversationScope('web', 'other')).reference(
        stored.artifactId,
      ),
    ).toBeUndefined();
  });

  test('uses broker identity in conversation ownership', () => {
    expect(artifactConversationScope('web', 'same')).not.toEqual(
      artifactConversationScope('discord', 'same'),
    );
  });

  test('honors the bound run cancellation before committing output', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stopped', 'AbortError'));
    const publisher = new ArtifactOutputSink(
      pipeline,
      artifactConversationScope('web', 'conversation-1'),
    ).publisher({ type: 'tool' }, controller.signal);

    await Promise.resolve();
    expect(
      publisher.publish({ data: new Blob(['never stored']), filename: 'cancelled.txt' }),
    ).rejects.toHaveProperty('name', 'AbortError');
  });
});
