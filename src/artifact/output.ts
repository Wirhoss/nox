import { type ArtifactPipeline, artifactRef } from './pipeline';
import { type ArtifactByteSource, type ArtifactScope, artifactScopeSchema } from './types';

import type { ContentArtifact } from '../content/content';

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
  publisher(provenance: ArtifactOutputProvenance, signal?: AbortSignal): ArtifactOutputPublisher;
}

/**
 * Binds every file produced through one capability to a host-selected scope and provenance.
 * Providers and tools never choose either, and only receive the small reference produced after
 * streaming ingestion has committed successfully.
 */
class ArtifactOutputSink implements ArtifactOutputHost {
  readonly #artifacts: ArtifactPipeline;
  readonly #scope: ArtifactScope;

  constructor(artifacts: ArtifactPipeline, scope: ArtifactScope) {
    this.#artifacts = artifacts;
    this.#scope = artifactScopeSchema.parse(scope);
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

/** Collision-free stable ownership for output produced inside one broker conversation. */
function artifactConversationScope(brokerId: string, conversationId: string): ArtifactScope {
  return artifactScopeSchema.parse({
    id: JSON.stringify([brokerId, conversationId]),
    type: 'conversation',
  });
}

export { artifactConversationScope, ArtifactOutputSink };

export type {
  ArtifactOutputHost,
  ArtifactOutputInput,
  ArtifactOutputProvenance,
  ArtifactOutputPublisher,
};
