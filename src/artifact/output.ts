import { ArtifactRepresentationUnavailableError } from './error';
import { artifactRef } from './pipeline';
import { artifactScopeSchema } from './types';

import type { ArtifactPipeline } from './pipeline';
import type { RepresentationProfile } from './representation';
import type { ArtifactByteSource, ArtifactScope } from './types';
import type { ContentArtifact } from '@nox/extension-api';

const ARTIFACT_TEXT_READ_PROFILE = Object.freeze({
  id: 'nox.agent.text-read',
  mediaTypes: Object.freeze([
    'text/*',
    'application/javascript',
    'application/json',
    'application/ld+json',
    'application/sql',
    'application/xml',
    'application/x-ndjson',
    'image/svg+xml',
  ]),
  version: 1,
}) satisfies RepresentationProfile;

interface ArtifactOutputInput {
  readonly data: ArtifactByteSource;
  readonly declaredMediaType?: string;
  readonly filename?: string;
}

interface ArtifactOutputProvenance {
  readonly details?: Readonly<Record<string, string>>;
  readonly type: 'provider' | 'tool';
}

/** A run-bound capability: the caller supplies bytes, while Nox owns identity and access. */
interface ArtifactOutputPublisher {
  publish(input: ArtifactOutputInput): Promise<ContentArtifact>;
}

interface ArtifactOutputHost {
  /**
   * Takes ownership of an artifact this scope does not own yet, by minting a
   * new one over the same bytes.
   *
   * Privileged, like `read`: it does not ask whether the caller was entitled to
   * the source, and whoever calls it has already decided that. What it
   * guarantees is that anything published from here is *published* — this scope
   * owns the copy it hands out, and the copy records where it came from, so a
   * later tool that rewrites it inherits a chain rather than an orphan.
   */
  adopt(artifactId: string, signal?: AbortSignal): Promise<ContentArtifact | undefined>;
  publisher(provenance: ArtifactOutputProvenance, signal?: AbortSignal): ArtifactOutputPublisher;
  reference(artifactId: string): Promise<ContentArtifact | undefined>;
}

interface ArtifactReadInput {
  readonly artifactId: string;
  readonly maxCharacters: number;
  readonly offset: number;
}

type ArtifactReadResult =
  | {
      readonly artifact: ContentArtifact['artifact'];
      readonly mediaType: string;
      readonly nextOffset?: number;
      readonly offset: number;
      readonly text: string;
      readonly type: 'text';
    }
  | {
      readonly artifact: ContentArtifact['artifact'];
      readonly type: 'binary';
    };

/** Host-side content access. The runner narrows it to IDs known by one conversation. */
interface ArtifactContentReader {
  read(input: ArtifactReadInput, signal?: AbortSignal): Promise<ArtifactReadResult | undefined>;
}

/** The response outbox exposed to the one explicit attachment tool. */
interface ArtifactResponseAttacher {
  addArtifact(artifactId: string): Promise<ContentArtifact>;
}

async function readTextPage(
  stream: ReadableStream<Uint8Array>,
  offset: number,
  maxCharacters: number,
  signal?: AbortSignal,
): Promise<{ readonly nextOffset?: number; readonly text: string }> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('Artifact read offset must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new RangeError('Artifact read maxCharacters must be a positive safe integer.');
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const selected: string[] = [];
  let complete = false;
  let hasMore: boolean;
  let skipped = 0;

  const consume = (text: string): boolean => {
    for (const character of text) {
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (selected.length < maxCharacters) {
        selected.push(character);
        continue;
      }
      return true;
    }
    return false;
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        hasMore = consume(decoder.decode());
        complete = true;
        break;
      }
      hasMore = consume(decoder.decode(chunk.value, { stream: true }));
      if (hasMore) break;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
  }

  if (!hasMore && skipped < offset) {
    throw new RangeError(
      `Artifact read offset ${String(offset)} is past the end of its textual representation.`,
    );
  }

  const text = selected.join('');
  return Object.freeze({
    ...(hasMore ? { nextOffset: offset + selected.length } : {}),
    text,
  });
}

/**
 * Binds every file produced through one capability to a host-selected scope and provenance.
 * Providers and tools never choose either, and only receive the small reference produced after
 * streaming ingestion has committed successfully.
 */
class ArtifactOutputSink implements ArtifactContentReader, ArtifactOutputHost {
  readonly #artifacts: ArtifactPipeline;
  readonly #scope: ArtifactScope;

  constructor(artifacts: ArtifactPipeline, scope: ArtifactScope) {
    this.#artifacts = artifacts;
    this.#scope = artifactScopeSchema.parse(scope);
  }

  /**
   * A second artifact over the same blob, owned by this scope.
   *
   * Bytes are streamed back through ingestion rather than re-scoped in place,
   * for two reasons. The original keeps its own identity and scope, so nothing
   * a past conversation holds changes underneath it; and the blob store is
   * content-addressed, so the copy costs a row and a hash rather than the
   * bytes. `derived` names the source, which is the whole point of copying
   * instead of widening a lookup.
   */
  public async adopt(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ContentArtifact | undefined> {
    const source = await this.#artifacts.find(artifactId);
    if (source === undefined) return undefined;
    if (source.scope.type === this.#scope.type && source.scope.id === this.#scope.id) {
      return Object.freeze({ artifact: artifactRef(source), type: 'artifact' });
    }

    const payload = await this.#artifacts.open(artifactId);
    signal?.throwIfAborted();
    const record = await this.#artifacts.ingest({
      data: payload.stream,
      declaredMediaType: source.mediaType,
      ...(source.filename === undefined ? {} : { filename: source.filename }),
      provenance: Object.freeze({
        details: Object.freeze({
          sourceArtifactId: source.artifactId,
          sourceScopeId: source.scope.id,
          sourceScopeType: source.scope.type,
        }),
        type: 'derived',
      }),
      scope: this.#scope,
      ...(signal === undefined ? {} : { signal }),
    });
    return Object.freeze({ artifact: artifactRef(record), type: 'artifact' });
  }

  public async reference(artifactId: string): Promise<ContentArtifact | undefined> {
    const reference = await this.#artifacts.ref(artifactId, this.#scope);
    return reference === undefined
      ? undefined
      : Object.freeze({ artifact: reference, type: 'artifact' });
  }

  /** Privileged storage read; callers must enforce conversation membership before invoking it. */
  public async read(
    input: ArtifactReadInput,
    signal?: AbortSignal,
  ): Promise<ArtifactReadResult | undefined> {
    const record = await this.#artifacts.find(input.artifactId);
    if (record === undefined) return undefined;

    const reference = artifactRef(record);
    signal?.throwIfAborted();

    try {
      const payload = await this.#artifacts.resolve(record.artifactId, ARTIFACT_TEXT_READ_PROFILE, {
        scope: record.scope,
        ...(signal === undefined ? {} : { signal }),
      });
      const page = await readTextPage(payload.stream, input.offset, input.maxCharacters, signal);
      signal?.throwIfAborted();
      return Object.freeze({
        artifact: reference,
        mediaType: payload.representation.mediaType,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        offset: input.offset,
        text: page.text,
        type: 'text',
      });
    } catch (error) {
      if (error instanceof ArtifactRepresentationUnavailableError) {
        return Object.freeze({ artifact: reference, type: 'binary' });
      }
      throw error;
    }
  }

  public publisher(
    provenance: ArtifactOutputProvenance,
    signal?: AbortSignal,
  ): ArtifactOutputPublisher {
    const frozenProvenance = Object.freeze({
      ...(provenance.details === undefined
        ? {}
        : { details: Object.freeze({ ...provenance.details }) }),
      type: provenance.type,
    });

    return Object.freeze({
      publish: async (input: ArtifactOutputInput): Promise<ContentArtifact> => {
        const record = await this.#artifacts.ingest({
          data: input.data,
          declaredMediaType: input.declaredMediaType,
          filename: input.filename,
          provenance: frozenProvenance,
          scope: this.#scope,
          ...(signal === undefined ? {} : { signal }),
        });
        return Object.freeze({ artifact: artifactRef(record), type: 'artifact' });
      },
    });
  }
}

export { ARTIFACT_TEXT_READ_PROFILE, ArtifactOutputSink };

export type {
  ArtifactContentReader,
  ArtifactOutputHost,
  ArtifactOutputInput,
  ArtifactOutputProvenance,
  ArtifactOutputPublisher,
  ArtifactReadInput,
  ArtifactReadResult,
  ArtifactResponseAttacher,
};
