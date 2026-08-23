import { createHash } from 'node:crypto';

import { z } from 'zod';

import { stableStringify } from '../utils/json';
import { type ArtifactRecord, mediaTypeSchema } from './types';

const representationProfileIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/u, 'Use a stable lowercase representation profile ID.');

const mediaRangeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => {
    if (value === '*/*') return true;
    const [type, subtype, extra] = value.split('/');
    if (extra !== undefined || type === undefined || subtype === undefined) return false;
    if (type === '*' || subtype.length === 0) return false;
    if (subtype === '*') return mediaTypeSchema.safeParse(`${type}/placeholder`).success;
    return mediaTypeSchema.safeParse(value).success;
  }, 'Use an Internet media type or a type wildcard such as image/*.');

const representationParameterSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(4_096),
  z.null(),
]);

const representationProfileSchema = z
  .object({
    id: representationProfileIdSchema,
    maxBytes: z.number().int().positive().optional(),
    mediaTypes: z.array(mediaRangeSchema).min(1).max(32),
    transform: z
      .record(z.string().trim().min(1).max(64), representationParameterSchema)
      .refine((value) => Object.keys(value).length <= 64, 'Use at most 64 transform parameters.')
      .optional(),
    version: z.number().int().positive(),
  })
  .strict();

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
  readonly processor: {
    readonly id: string;
    readonly version: string;
  };
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

function normalizeRepresentationProfile(input: RepresentationProfile): RepresentationProfile {
  const parsed = representationProfileSchema.parse(input);
  const mediaTypes = Object.freeze([...new Set(parsed.mediaTypes)]);
  const transform =
    parsed.transform === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(parsed.transform).sort(([left], [right]) => left.localeCompare(right)),
          ),
        );

  return Object.freeze({
    id: parsed.id,
    ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }),
    mediaTypes,
    ...(transform === undefined ? {} : { transform }),
    version: parsed.version,
  });
}

function representationProfileDigest(profile: RepresentationProfile): string {
  return createHash('sha256').update(stableStringify(profile)).digest('hex');
}

function mediaTypeMatches(mediaType: string, range: string): boolean {
  if (range === '*/*' || range === mediaType) return true;
  return range.endsWith('/*') && mediaType.startsWith(range.slice(0, -1));
}

function profileAcceptsMediaType(profile: RepresentationProfile, mediaType: string): boolean {
  return profile.mediaTypes.some((range) => mediaTypeMatches(mediaType, range));
}

function profileAcceptsOriginal(profile: RepresentationProfile, artifact: ArtifactRecord): boolean {
  return (
    profile.transform === undefined &&
    profileAcceptsMediaType(profile, artifact.mediaType) &&
    (profile.maxBytes === undefined || artifact.size <= profile.maxBytes)
  );
}

export {
  mediaRangeSchema,
  normalizeRepresentationProfile,
  profileAcceptsMediaType,
  profileAcceptsOriginal,
  representationProfileDigest,
  representationProfileIdSchema,
  representationProfileSchema,
};

export type {
  ArtifactOriginalRepresentation,
  ArtifactRenditionRepresentation,
  ArtifactRepresentation,
  ArtifactResolvedPayload,
  RepresentationParameter,
  RepresentationProfile,
};
