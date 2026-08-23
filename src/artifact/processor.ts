import { z } from 'zod';

import type { ArtifactByteSource } from './types';
import type { RepresentationProfile } from './representation';

const artifactProcessorIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/u, 'Use a stable lowercase artifact processor ID.');

const artifactProcessorVersionSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u, 'Use a stable artifact processor version.');

interface ArtifactProcessorSource {
  readonly blobHash: string;
  readonly mediaType: string;
  readonly size: number;
}

interface ArtifactProcessorInput {
  readonly profile: RepresentationProfile;
  readonly signal?: AbortSignal;
  readonly source: ArtifactProcessorSource & {
    readonly stream: ReadableStream<Uint8Array>;
  };
}

interface ArtifactProcessorOutput {
  readonly data: ArtifactByteSource;
  readonly mediaType: string;
}

interface ArtifactProcessor {
  readonly id: string;
  readonly priority?: number;
  readonly version: string;

  /** Pure capability test. It must not inspect or consume source bytes. */
  supports(source: ArtifactProcessorSource, profile: RepresentationProfile): boolean;

  /**
   * Mechanically transforms bytes. For one source, profile, processor ID and
   * version this must always produce the same bytes and media type.
   */
  process(input: ArtifactProcessorInput): ArtifactProcessorOutput | Promise<ArtifactProcessorOutput>;
}

interface RegisteredProcessor {
  readonly priority: number;
  readonly processor: ArtifactProcessor;
}

/** Process-lifetime registry with deterministic selection independent of registration order. */
class ArtifactProcessorRegistry {
  readonly #processors = new Map<string, RegisteredProcessor>();

  constructor(processors: readonly ArtifactProcessor[] = []) {
    for (const processor of processors) this.register(processor);
  }

  public register(processor: ArtifactProcessor): () => void {
    const id = artifactProcessorIdSchema.parse(processor.id);
    artifactProcessorVersionSchema.parse(processor.version);
    const priority = processor.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      throw new RangeError(`Artifact processor "${id}" priority must be a safe integer.`);
    }
    if (this.#processors.has(id)) {
      throw new Error(`Artifact processor "${id}" is already registered.`);
    }

    const registered = Object.freeze({ priority, processor });
    this.#processors.set(id, registered);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#processors.get(id) === registered) this.#processors.delete(id);
    };
  }

  public select(
    source: ArtifactProcessorSource,
    profile: RepresentationProfile,
  ): ArtifactProcessor | undefined {
    return [...this.#processors.values()]
      .filter(({ processor }) => processor.supports(source, profile))
      .sort(
        (left, right) =>
          right.priority - left.priority || left.processor.id.localeCompare(right.processor.id),
      )[0]?.processor;
  }
}

export {
  ArtifactProcessorRegistry,
  artifactProcessorIdSchema,
  artifactProcessorVersionSchema,
};

export type {
  ArtifactProcessor,
  ArtifactProcessorInput,
  ArtifactProcessorOutput,
  ArtifactProcessorSource,
};
