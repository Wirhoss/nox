import { extname } from 'node:path';

import { mediaTypeSchema } from './types';

const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';
const PROBE_BYTES = 8_192;

const ZIP_CONTAINER_TYPES = new Set([
  'application/epub+zip',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.epub': 'application/epub+zip',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

interface ArtifactProbeResult {
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly mediaType: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/**
 * Deliberately small and deterministic. A richer detector can replace this probe
 * without changing storage; an unrecognised file is still a valid artifact.
 */
function detectMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'application/ogg';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip';
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip';
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === 'ftyp') return 'video/mp4';
  if (startsWith(bytes, [0x4d, 0x5a])) return 'application/vnd.microsoft.portable-executable';
  return undefined;
}

function normalizedMediaType(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const withoutParameters = value.split(';', 1)[0]?.trim().toLowerCase();
  const parsed = mediaTypeSchema.safeParse(withoutParameters);
  return parsed.success ? parsed.data : undefined;
}

function mediaTypeFromFilename(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  return EXTENSION_MEDIA_TYPES[extname(filename).toLowerCase()];
}

function probeArtifact(
  bytes: Uint8Array,
  declared: string | undefined,
  filename: string | undefined,
): ArtifactProbeResult {
  const declaredMediaType = normalizedMediaType(declared);
  const detectedMediaType = detectMediaType(bytes);
  const namedMediaType = mediaTypeFromFilename(filename);

  // ZIP is a container, not necessarily the format people uploaded. Preserve a
  // specific OOXML/ODF/EPUB declaration or extension while recording ZIP as the
  // independently detected container in its own field.
  const containerType =
    detectedMediaType === 'application/zip'
      ? [declaredMediaType, namedMediaType].find(
          (candidate): candidate is string =>
            candidate !== undefined && ZIP_CONTAINER_TYPES.has(candidate),
        )
      : undefined;

  return Object.freeze({
    ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    ...(detectedMediaType === undefined ? {} : { detectedMediaType }),
    mediaType:
      containerType ??
      detectedMediaType ??
      declaredMediaType ??
      namedMediaType ??
      UNKNOWN_MEDIA_TYPE,
  });
}

export { PROBE_BYTES, probeArtifact, UNKNOWN_MEDIA_TYPE };

export type { ArtifactProbeResult };
