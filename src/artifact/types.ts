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
  .object({
    id: z.string().min(1).max(255),
    type: z.enum(ARTIFACT_SCOPE_TYPES),
  })
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

interface ArtifactRecord extends ArtifactRef {
  readonly blobHash: string;
  readonly createdAt: number;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly provenance: ArtifactProvenance;
  readonly scope: ArtifactScope;
}

type ArtifactByteSource = AsyncIterable<Uint8Array> | Blob | ReadableStream<Uint8Array>;

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

export {
  ARTIFACT_PROVENANCE_TYPES,
  ARTIFACT_SCOPE_TYPES,
  artifactIdSchema,
  artifactProvenanceSchema,
  artifactRefSchema,
  artifactScopeSchema,
  mediaTypeSchema,
};

export type {
  ArtifactByteSource,
  ArtifactIngestInput,
  ArtifactPayload,
  ArtifactProvenance,
  ArtifactProvenanceType,
  ArtifactRecord,
  ArtifactRef,
  ArtifactScope,
  ArtifactScopeType,
};
