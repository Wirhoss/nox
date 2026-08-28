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

  test('adopting mints a copy this scope owns, over the same bytes, naming its source', async () => {
    const origin = artifactConversationScope('discord', 'channel-old');
    const here = artifactConversationScope('discord', 'channel-new');
    const published = await new ArtifactOutputSink(pipeline, origin)
      .publisher({ type: 'tool' })
      .publish({ data: new Blob(['the photo bytes']), declaredMediaType: 'text/plain' });

    const adopted = await new ArtifactOutputSink(pipeline, here).adopt(
      published.artifact.artifactId,
    );
    if (adopted === undefined) throw new Error('Adoption produced nothing.');

    const copy = await pipeline.find(adopted.artifact.artifactId, here);
    const source = await pipeline.find(published.artifact.artifactId, origin);
    if (copy === undefined || source === undefined) throw new Error('An artifact went missing.');

    // A new identity owned here, the same content, and a provenance that says
    // where it came from - which is what a later tool rewriting it inherits.
    expect(copy.artifactId).not.toBe(source.artifactId);
    expect(copy.scope).toEqual(here);
    expect(copy.blobHash).toBe(source.blobHash);
    expect(copy.provenance).toEqual({
      details: {
        sourceArtifactId: source.artifactId,
        sourceScopeId: origin.id,
        sourceScopeType: 'conversation',
      },
      type: 'derived',
    });
    // The original is untouched and still belongs to the conversation that
    // produced it: adoption copies, it never re-scopes in place.
    expect(source.scope).toEqual(origin);
  });

  test('adopting what this scope already owns hands back the artifact, not a duplicate', async () => {
    const scope = artifactConversationScope('discord', 'channel-1');
    const sink = new ArtifactOutputSink(pipeline, scope);
    const published = await sink
      .publisher({ type: 'tool' })
      .publish({ data: new Blob(['already mine']), declaredMediaType: 'text/plain' });

    const adopted = await sink.adopt(published.artifact.artifactId);

    // Attaching twice must not grow a chain of copies of the same thing.
    expect(adopted).toEqual(published);
  });

  test('adopting an artifact that does not exist produces nothing', async () => {
    const sink = new ArtifactOutputSink(pipeline, artifactConversationScope('discord', 'c'));

    expect(await sink.adopt('art_missing00001')).toBeUndefined();
  });

  test('reads textual artifacts in bounded Unicode pages through a representation profile', async () => {
    const scope = artifactConversationScope('web', 'conversation-text');
    const sink = new ArtifactOutputSink(pipeline, scope);
    const part = await sink.publisher({ type: 'tool' }).publish({
      data: new Blob(['á😀bc']),
      declaredMediaType: 'text/plain',
      filename: 'unicode.txt',
    });

    const first = await sink.read({
      artifactId: part.artifact.artifactId,
      maxCharacters: 2,
      offset: 0,
    });
    const second = await sink.read({
      artifactId: part.artifact.artifactId,
      maxCharacters: 2,
      offset: 2,
    });

    expect(first).toEqual({
      artifact: part.artifact,
      mediaType: 'text/plain',
      nextOffset: 2,
      offset: 0,
      text: 'á😀',
      type: 'text',
    });
    expect(second).toEqual({
      artifact: part.artifact,
      mediaType: 'text/plain',
      offset: 2,
      text: 'bc',
      type: 'text',
    });
    expect(
      sink.read({ artifactId: part.artifact.artifactId, maxCharacters: 2, offset: 99 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test('uses registered deterministic processors for textual artifact renditions', async () => {
    pipeline.processors.register({
      id: 'test.pdf.text',
      process: () => ({ data: new Blob(['extracted PDF']), mediaType: 'text/plain' }),
      supports: (source, profile) =>
        source.mediaType === 'application/pdf' && profile.id === 'nox.agent.text-read',
      version: '1',
    });
    const scope = artifactConversationScope('web', 'conversation-pdf');
    const sink = new ArtifactOutputSink(pipeline, scope);
    const part = await sink.publisher({ type: 'tool' }).publish({
      data: new Blob(['%PDF- fixture']),
      declaredMediaType: 'application/pdf',
      filename: 'report.pdf',
    });

    const result = await sink.read({
      artifactId: part.artifact.artifactId,
      maxCharacters: 100,
      offset: 0,
    });

    expect(result).toEqual({
      artifact: part.artifact,
      mediaType: 'text/plain',
      offset: 0,
      text: 'extracted PDF',
      type: 'text',
    });
  });

  test('returns a binary reference when no textual representation exists', async () => {
    const scope = artifactConversationScope('web', 'conversation-image');
    const sink = new ArtifactOutputSink(pipeline, scope);
    const part = await sink.publisher({ type: 'tool' }).publish({
      data: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]),
      declaredMediaType: 'image/png',
      filename: 'image.png',
    });

    expect(
      await sink.read({ artifactId: part.artifact.artifactId, maxCharacters: 100, offset: 0 }),
    ).toEqual({ artifact: part.artifact, type: 'binary' });
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
