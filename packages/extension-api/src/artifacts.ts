import { z } from 'zod';

const ARTIFACT_SCOPE_TYPES = ['account', 'conversation', 'session', 'system'] as const;
const ARTIFACT_PROVENANCE_TYPES = ['broker', 'derived', 'provider', 'tool', 'upload'] as const;

const mediaTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Use an Internet media type.');
const artifactIdSchema = z
  .string()
  .regex(/^art_[A-Za-z0-9_-]{8,64}$/, 'Use an artifact ID issued by Nox.');
const artifactRefSchema = z
  .object({
    artifactId: artifactIdSchema,
    filename: z.string().min(1).max(255).optional(),
    mediaType: mediaTypeSchema,
    size: z.number().int().nonnegative(),
  })
  .readonly();
const artifactScopeSchema = z
  .object({ id: z.string().min(1).max(255), type: z.enum(ARTIFACT_SCOPE_TYPES) })
  .readonly();
const artifactProvenanceSchema = z
  .object({
    details: z.record(z.string(), z.string()).optional(),
    type: z.enum(ARTIFACT_PROVENANCE_TYPES),
  })
  .readonly();

type ArtifactRef = z.infer<typeof artifactRefSchema>;
type ArtifactScope = z.infer<typeof artifactScopeSchema>;
type ArtifactScopeType = (typeof ARTIFACT_SCOPE_TYPES)[number];
type ArtifactProvenance = z.infer<typeof artifactProvenanceSchema>;
type ArtifactProvenanceType = (typeof ARTIFACT_PROVENANCE_TYPES)[number];
type ArtifactByteSource = AsyncIterable<Uint8Array> | Blob | ReadableStream<Uint8Array>;

interface ArtifactRecord extends ArtifactRef {
  readonly blobHash: string;
  readonly createdAt: number;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly provenance: ArtifactProvenance;
  readonly scope: ArtifactScope;
}

interface ArtifactIngestInput {
  readonly data: ArtifactByteSource;
  readonly declaredMediaType?: string;
  readonly filename?: string;
  readonly provenance: ArtifactProvenance;
  readonly scope: ArtifactScope;
  readonly signal?: AbortSignal;
}

interface ArtifactPayload {
  readonly artifact: ArtifactRecord;
  readonly stream: ReadableStream<Uint8Array>;
}

type RepresentationParameter = boolean | null | number | string;

interface RepresentationProfile {
  readonly id: string;
  readonly maxBytes?: number;
  readonly mediaTypes: readonly string[];
  readonly transform?: Readonly<Record<string, RepresentationParameter>>;
  readonly version: number;
}

interface ArtifactOriginalRepresentation {
  readonly blobHash: string;
  readonly mediaType: string;
  readonly size: number;
  readonly type: 'original';
}

interface ArtifactRenditionRepresentation {
  readonly blobHash: string;
  readonly createdAt: number;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly mediaType: string;
  readonly processor: { readonly id: string; readonly version: string };
  readonly profile: RepresentationProfile;
  readonly renditionId: string;
  readonly size: number;
  readonly sourceBlobHash: string;
  readonly sourceMediaType: string;
  readonly type: 'rendition';
}

type ArtifactRepresentation = ArtifactOriginalRepresentation | ArtifactRenditionRepresentation;

interface ArtifactResolvedPayload {
  readonly artifact: ArtifactRecord;
  readonly representation: ArtifactRepresentation;
  readonly stream: ReadableStream<Uint8Array>;
}

interface ArtifactProcessorSource {
  readonly blobHash: string;
  readonly mediaType: string;
  readonly size: number;
}

interface ArtifactProcessorInput {
  readonly profile: RepresentationProfile;
  readonly signal?: AbortSignal;
  readonly source: ArtifactProcessorSource & { readonly stream: ReadableStream<Uint8Array> };
}

interface ArtifactProcessorOutput {
  readonly data: ArtifactByteSource;
  readonly mediaType: string;
}

interface ArtifactProcessor {
  readonly id: string;
  readonly priority?: number;
  readonly version: string;
  supports(source: ArtifactProcessorSource, profile: RepresentationProfile): boolean;
  process(
    input: ArtifactProcessorInput,
  ): ArtifactProcessorOutput | Promise<ArtifactProcessorOutput>;
}

interface ArtifactProcessorCatalog {
  register(processor: ArtifactProcessor): { dispose(): Promise<void> | void };
}

interface ArtifactResolveOptions {
  readonly scope?: ArtifactScope;
  readonly signal?: AbortSignal;
}

/** The intentionally bounded artifact capability available to extensions. */
interface ArtifactPipeline {
  readonly processors: ArtifactProcessorCatalog;
  find(artifactId: string, scope?: ArtifactScope): Promise<ArtifactRecord | undefined>;
  ingest(input: ArtifactIngestInput): Promise<ArtifactRecord>;
  resolve(
    artifactId: string,
    profile: RepresentationProfile,
    options?: ArtifactResolveOptions,
  ): Promise<ArtifactResolvedPayload>;
}

interface ArtifactOutputInput {
  readonly data: ArtifactByteSource;
  readonly declaredMediaType?: string;
  readonly filename?: string;
}

interface ArtifactOutputPublisher {
  publish(input: ArtifactOutputInput): Promise<import('./content.js').ContentArtifact>;
}

interface ArtifactContentReader {
  read(
    input: { readonly artifactId: string; readonly maxCharacters: number; readonly offset: number },
    signal?: AbortSignal,
  ): Promise<
    | undefined
    | {
        readonly artifact: ArtifactRef;
        readonly mediaType: string;
        readonly nextOffset?: number;
        readonly offset: number;
        readonly text: string;
        readonly type: 'text';
      }
    | { readonly artifact: ArtifactRef; readonly type: 'binary' }
  >;
}

interface ArtifactResponseAttacher {
  addArtifact(artifactId: string): Promise<import('./content.js').ContentArtifact>;
}

class ArtifactRepresentationUnavailableError extends Error {
  public readonly artifactId: string;
  public readonly profileId: string;

  constructor(artifactId: string, profileId: string, mediaType: string) {
    super(
      `Artifact "${artifactId}" (${mediaType}) has no representation for profile "${profileId}".`,
    );
    this.name = 'ArtifactRepresentationUnavailableError';
    this.artifactId = artifactId;
    this.profileId = profileId;
  }
}

class ArtifactProcessorOutputError extends Error {
  public readonly processorId: string;

  constructor(processorId: string, message: string, options?: ErrorOptions) {
    super(`Artifact processor "${processorId}" ${message}`, options);
    this.name = 'ArtifactProcessorOutputError';
    this.processorId = processorId;
  }
}

function isArtifactProcessorOutputError(error: unknown): error is ArtifactProcessorOutputError {
  return (
    error instanceof ArtifactProcessorOutputError ||
    (error instanceof Error &&
      error.name === 'ArtifactProcessorOutputError' &&
      typeof Reflect.get(error, 'processorId') === 'string')
  );
}

function isArtifactRepresentationUnavailableError(
  error: unknown,
): error is ArtifactRepresentationUnavailableError {
  return (
    error instanceof ArtifactRepresentationUnavailableError ||
    (error instanceof Error &&
      error.name === 'ArtifactRepresentationUnavailableError' &&
      typeof Reflect.get(error, 'artifactId') === 'string' &&
      typeof Reflect.get(error, 'profileId') === 'string')
  );
}

export {
  ARTIFACT_PROVENANCE_TYPES,
  ARTIFACT_SCOPE_TYPES,
  artifactIdSchema,
  ArtifactProcessorOutputError,
  artifactProvenanceSchema,
  artifactRefSchema,
  ArtifactRepresentationUnavailableError,
  artifactScopeSchema,
  isArtifactProcessorOutputError,
  isArtifactRepresentationUnavailableError,
  mediaTypeSchema,
};

export type {
  ArtifactByteSource,
  ArtifactContentReader,
  ArtifactIngestInput,
  ArtifactOriginalRepresentation,
  ArtifactOutputInput,
  ArtifactOutputPublisher,
  ArtifactPayload,
  ArtifactPipeline,
  ArtifactProcessor,
  ArtifactProcessorCatalog,
  ArtifactProcessorInput,
  ArtifactProcessorOutput,
  ArtifactProcessorSource,
  ArtifactProvenance,
  ArtifactProvenanceType,
  ArtifactRecord,
  ArtifactRef,
  ArtifactRenditionRepresentation,
  ArtifactRepresentation,
  ArtifactResolvedPayload,
  ArtifactResolveOptions,
  ArtifactResponseAttacher,
  ArtifactScope,
  ArtifactScopeType,
  RepresentationParameter,
  RepresentationProfile,
};
