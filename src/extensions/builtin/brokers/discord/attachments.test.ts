import {
  type ArtifactIngestInput,
  type ArtifactPipeline,
  type ArtifactRecord,
  type ArtifactResolveOptions,
  type ArtifactScope,
  type ContentArtifact,
  silentLogger,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import {
  attachmentsOf,
  MAX_UPLOAD_BYTES,
  toMessageContent,
  toUploads,
  type UploadOptions,
} from './attachments';

const CHANNEL = '300000000000000003';

/** The scope the host names for this channel, in the shape the gateway builds. */
const SCOPE = Object.freeze({
  id: JSON.stringify(['discord', CHANNEL]),
  type: 'conversation' as const,
});

/** Records what it was asked to store, and answers as the real pipeline would. */
function fakePipeline(): { ingested: ArtifactIngestInput[]; pipeline: ArtifactPipeline } {
  const ingested: ArtifactIngestInput[] = [];
  const pipeline = {
    find: () => Promise.resolve(undefined),
    ingest: async (input: ArtifactIngestInput): Promise<ArtifactRecord> => {
      ingested.push(input);
      // Drained so a stream left unread cannot make the test pass by accident.
      const bytes = await new Response(input.data as ReadableStream<Uint8Array>).arrayBuffer();
      return {
        artifactId: `art_${String(ingested.length)}0000000`,
        blobHash: 'hash',
        createdAt: 0,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        mediaType: input.declaredMediaType ?? 'application/octet-stream',
        provenance: input.provenance,
        scope: input.scope,
        size: bytes.byteLength,
      };
    },
    processors: { get: () => undefined, list: () => [] },
    resolve: () => Promise.reject(new Error('unused')),
  } as unknown as ArtifactPipeline;

  return { ingested, pipeline };
}

/**
 * Answers with the bytes it was built on, as the pipeline hands originals back,
 * and only for the scope it was told those bytes live in — which is what makes
 * an ID from another conversation resolve to nothing here, exactly as it would
 * against the real store.
 */
function readingPipeline(
  bytes: string,
  options: { fails?: boolean; scope?: ArtifactScope } = {},
): { asked: ArtifactResolveOptions[]; pipeline: ArtifactPipeline } {
  const asked: ArtifactResolveOptions[] = [];
  const owner = options.scope ?? SCOPE;
  const pipeline = {
    find: () => Promise.resolve(undefined),
    ingest: () => Promise.reject(new Error('unused')),
    processors: { get: () => undefined, list: () => [] },
    resolve: (_artifactId: string, _profile: unknown, given: ArtifactResolveOptions = {}) => {
      asked.push(given);
      if (options.fails === true) return Promise.reject(new Error('unreadable'));
      if (given.scope !== undefined && given.scope.id !== owner.id) {
        return Promise.reject(new Error('no such artifact'));
      }
      return Promise.resolve({
        artifact: {},
        representation: { mediaType: 'image/png', type: 'original' },
        stream: new Response(bytes).body,
      });
    },
  } as unknown as ArtifactPipeline;

  return { asked, pipeline };
}

function uploadOptions(pipeline?: ArtifactPipeline): UploadOptions {
  return {
    logger: silentLogger,
    pipeline,
    scope: SCOPE,
    signal: new AbortController().signal,
  };
}

function artifactPart(overrides: Partial<ContentArtifact['artifact']> = {}): ContentArtifact {
  return {
    artifact: {
      artifactId: 'art_10000000',
      filename: 'shot.png',
      mediaType: 'image/png',
      size: 9,
      ...overrides,
    },
    type: 'artifact',
  };
}

describe('attachmentsOf', () => {
  test('keeps only entries that name both a file and where to get it', () => {
    expect(
      attachmentsOf([
        { filename: 'a.png', id: '1', url: 'https://cdn.example/a.png' },
        { filename: 'b.png' },
        'nonsense',
        null,
      ]),
    ).toEqual([{ filename: 'a.png', id: '1', url: 'https://cdn.example/a.png' }]);
  });

  test('answers with nothing for a message that carried no files', () => {
    expect(attachmentsOf(undefined)).toEqual([]);
  });
});

describe('toMessageContent', () => {
  test('carries what was typed', async () => {
    expect(await toMessageContent('  hello  ', undefined, uploadOptions())).toEqual([
      { text: 'hello', type: 'text' },
    ]);
  });

  test('stores a file and carries the reference, scoped to the conversation', async () => {
    const { ingested, pipeline } = fakePipeline();
    const server = Bun.serve({ fetch: () => new Response('png-bytes'), port: 0 });

    try {
      const parts = await toMessageContent(
        'look',
        [
          {
            content_type: 'image/png',
            filename: 'shot.png',
            id: '77',
            url: server.url.toString(),
          },
        ],
        uploadOptions(pipeline),
      );

      expect(parts).toEqual([
        { text: 'look', type: 'text' },
        {
          artifact: {
            artifactId: 'art_10000000',
            filename: 'shot.png',
            mediaType: 'image/png',
            size: 9,
          },
          type: 'artifact',
        },
      ]);
      // The host names where a conversation's files live; nothing here derives it.
      expect(ingested[0]?.scope).toEqual(SCOPE);
      // Provenance says the bytes arrived over a transport, not from a tool.
      expect(ingested[0]?.provenance.type).toBe('broker');
      // Declared, never trusted: the pipeline keeps both and detects the real one.
      expect(ingested[0]?.declaredMediaType).toBe('image/png');
    } finally {
      await server.stop(true);
    }
  });

  test('a file that could not be stored does not take the message with it', async () => {
    const server = Bun.serve({ fetch: () => new Response('gone', { status: 404 }), port: 0 });

    try {
      const parts = await toMessageContent(
        'look',
        [{ id: '77', url: server.url.toString() }],
        uploadOptions(fakePipeline().pipeline),
      );

      expect(parts).toEqual([{ text: 'look', type: 'text' }]);
    } finally {
      await server.stop(true);
    }
  });

  test('carries text alone where Nox has no artifact pipeline', async () => {
    const parts = await toMessageContent(
      'look',
      [{ id: '77', url: 'https://cdn.example/a.png' }],
      uploadOptions(),
    );

    expect(parts).toEqual([{ text: 'look', type: 'text' }]);
  });
});

describe('toUploads', () => {
  test('reads an artifact back as the bytes to post, under the conversation it belongs to', async () => {
    const { asked, pipeline } = readingPipeline('png-bytes');
    const { missed, uploads } = await toUploads(
      [{ text: 'here', type: 'text' }, artifactPart()],
      uploadOptions(pipeline),
    );

    expect(missed).toEqual([]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ filename: 'shot.png', mediaType: 'image/png' });
    expect(new TextDecoder().decode(uploads[0]?.bytes)).toBe('png-bytes');
    // Scoped rather than read privileged: an artifact ID is only ever readable in
    // the conversation it was filed under.
    expect(asked[0]?.scope).toEqual(SCOPE);
  });

  test('cannot post a file that belongs to another conversation', async () => {
    const { pipeline } = readingPipeline('png-bytes', {
      scope: { id: JSON.stringify(['discord', 'another-channel']), type: 'conversation' },
    });

    const { missed, uploads } = await toUploads([artifactPart()], uploadOptions(pipeline));

    expect(uploads).toEqual([]);
    expect(missed).toEqual(['shot.png']);
  });

  test('names a file that is past what a message can carry instead of dropping it', async () => {
    const { pipeline } = readingPipeline('png-bytes');

    const { missed, uploads } = await toUploads(
      [artifactPart({ size: MAX_UPLOAD_BYTES + 1 })],
      uploadOptions(pipeline),
    );

    expect(uploads).toEqual([]);
    expect(missed).toEqual(['shot.png']);
  });

  test('names a file it could not read, so the reply is not quietly incomplete', async () => {
    const { pipeline } = readingPipeline('png-bytes', { fails: true });

    const { missed, uploads } = await toUploads([artifactPart()], uploadOptions(pipeline));

    expect(uploads).toEqual([]);
    expect(missed).toEqual(['shot.png']);
  });

  test('flattens a path separator, so a file cannot arrive under another name', async () => {
    const { pipeline } = readingPipeline('png-bytes');

    const { uploads } = await toUploads(
      [artifactPart({ filename: 'a/b.png' })],
      uploadOptions(pipeline),
    );

    expect(uploads[0]?.filename).toBe('a_b.png');
  });
});
