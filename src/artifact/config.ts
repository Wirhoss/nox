import { z } from 'zod';

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

const byteLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Restart-scoped limits for immutable originals and deterministic renditions together. */
const artifactConfigSchema = z
  .object({
    maxArtifactBytes: byteLimitSchema.default(DEFAULT_MAX_ARTIFACT_BYTES),
    maxStorageBytes: byteLimitSchema.default(DEFAULT_MAX_ARTIFACT_STORAGE_BYTES),
  })
  .refine((value) => value.maxStorageBytes >= value.maxArtifactBytes, {
    message: 'Artifact storage must hold at least one maximum-sized artifact.',
    path: ['maxStorageBytes'],
  });

type ArtifactConfig = z.infer<typeof artifactConfigSchema>;

export { artifactConfigSchema, DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_STORAGE_BYTES };

export type { ArtifactConfig };
