import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { z } from 'zod';

import { stableStringify } from '../../../../utils/json';

import type {
  ArtifactProcessor,
  ArtifactProcessorInput,
  ArtifactProcessorOutput,
  ArtifactProcessorSource,
} from '../../../../artifact/processor';
import type { RepresentationProfile } from '../../../../artifact/representation';

const SHARP_IMAGE_PROCESSOR_ID = 'nox.image.sharp';
const SHARP_ENGINE_FINGERPRINT = createHash('sha256')
  .update(
    stableStringify({
      architecture: process.arch,
      platform: process.platform,
      versions: sharp.versions,
    }),
  )
  .digest('hex')
  .slice(0, 12);
const SHARP_IMAGE_PROCESSOR_VERSION =
  `1-sharp${sharp.versions.sharp}-vips${sharp.versions.vips}-${SHARP_ENGINE_FINGERPRINT}` as const;
const SHARP_IMAGE_PROCESSOR_PRIORITY = 100;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 8_192;
const PROCESSING_TIMEOUT_SECONDS = 30;
const DEFAULT_BACKGROUND = '#ffffff';

const INPUT_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
]);

const OUTPUT_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const imageFitSchema = z.enum(['contain', 'cover', 'fill', 'inside']);
const imagePositionSchema = z.enum([
  'attention',
  'bottom',
  'center',
  'centre',
  'east',
  'entropy',
  'left',
  'left bottom',
  'left top',
  'north',
  'northeast',
  'northwest',
  'right',
  'right bottom',
  'right top',
  'south',
  'southeast',
  'southwest',
  'top',
  'west',
]);

const sharpImageTransformSchema = z
  .object({
    autoOrient: z.boolean().optional(),
    background: z.string().trim().min(1).max(128).optional(),
    fit: imageFitSchema.optional(),
    height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
    position: imagePositionSchema.optional(),
    quality: z.number().int().min(1).max(100).optional(),
    width: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
    withoutEnlargement: z.boolean().optional(),
  })
  .strict();

type SharpImageTransform = z.infer<typeof sharpImageTransformSchema>;
type SharpOutputMediaType = 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

function outputMediaType(
  source: ArtifactProcessorSource,
  profile: RepresentationProfile,
): SharpOutputMediaType | undefined {
  if (
    profile.transform === undefined &&
    OUTPUT_MEDIA_TYPES.has(source.mediaType) &&
    profile.mediaTypes.some(
      (range) => range === source.mediaType || range === 'image/*' || range === '*/*',
    )
  ) {
    return source.mediaType as SharpOutputMediaType;
  }

  for (const range of profile.mediaTypes) {
    if (OUTPUT_MEDIA_TYPES.has(range)) return range as SharpOutputMediaType;
    if (range === 'image/*' || range === '*/*') {
      return OUTPUT_MEDIA_TYPES.has(source.mediaType)
        ? (source.mediaType as SharpOutputMediaType)
        : 'image/png';
    }
  }
  return undefined;
}

function validTransform(
  profile: RepresentationProfile,
  mediaType: SharpOutputMediaType,
): SharpImageTransform | undefined {
  const parsed = sharpImageTransformSchema.safeParse(profile.transform ?? {});
  if (!parsed.success) return undefined;

  const { background, fit, height, position, width, withoutEnlargement } = parsed.data;
  const hasDimensions = width !== undefined || height !== undefined;
  const hasBothDimensions = width !== undefined && height !== undefined;
  if ((fit !== undefined || position !== undefined) && !hasBothDimensions) return undefined;
  if (position !== undefined && fit !== 'contain' && fit !== 'cover') return undefined;
  if (background !== undefined && fit !== 'contain' && mediaType !== 'image/jpeg') return undefined;
  if (withoutEnlargement !== undefined && !hasDimensions) return undefined;
  if (withoutEnlargement === false && !hasBothDimensions) return undefined;
  return parsed.data;
}

function configureOutput(
  image: ReturnType<typeof sharp>,
  mediaType: SharpOutputMediaType,
  transform: SharpImageTransform,
): ReturnType<typeof sharp> {
  switch (mediaType) {
    case 'image/avif':
      return image.avif({
        chromaSubsampling: '4:4:4',
        effort: 4,
        lossless: false,
        quality: transform.quality ?? 60,
      });
    case 'image/gif':
      return image.gif({
        colours:
          transform.quality === undefined
            ? 256
            : Math.max(2, Math.round((transform.quality / 100) * 256)),
        effort: 7,
        progressive: false,
        reuse: transform.quality === undefined,
      });
    case 'image/jpeg':
      return image.flatten({ background: transform.background ?? DEFAULT_BACKGROUND }).jpeg({
        chromaSubsampling: '4:2:0',
        optimiseCoding: true,
        progressive: false,
        quality: transform.quality ?? 85,
      });
    case 'image/png':
      return image.png({
        adaptiveFiltering: false,
        compressionLevel: 9,
        ...(transform.quality === undefined
          ? { palette: false }
          : { effort: 7, palette: true, quality: transform.quality }),
        progressive: false,
      });
    case 'image/webp':
      return image.webp({
        alphaQuality: 100,
        effort: 4,
        lossless: false,
        quality: transform.quality ?? 85,
        smartSubsample: false,
      });
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Image processing was aborted.', 'AbortError');
}

async function* renderedImage(
  source: ReadableStream<Uint8Array>,
  mediaType: SharpOutputMediaType,
  transform: SharpImageTransform,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  let image = sharp({
    animated: mediaType === 'image/gif' || mediaType === 'image/webp',
    autoOrient: transform.autoOrient ?? true,
    density: 72,
    failOn: 'warning',
    limitInputChannels: 4,
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
    unlimited: false,
  });

  if (transform.width !== undefined || transform.height !== undefined) {
    image = image.resize({
      ...(transform.background === undefined ? {} : { background: transform.background }),
      fit: transform.fit ?? 'inside',
      height: transform.height,
      kernel: 'lanczos3',
      position: transform.position ?? 'centre',
      width: transform.width,
      withoutEnlargement: transform.withoutEnlargement ?? true,
    });
  }
  image = configureOutput(image, mediaType, transform).timeout({
    seconds: PROCESSING_TIMEOUT_SECONDS,
  });

  const input = Readable.fromWeb(source);
  const onInputError = (error: Error): void => {
    image.destroy(error);
  };
  const onAbort = (): void => {
    const error =
      signal === undefined ? new DOMException('Aborted', 'AbortError') : abortError(signal);
    input.destroy(error);
    image.destroy(error);
  };
  input.once('error', onInputError);
  signal?.addEventListener('abort', onAbort, { once: true });
  input.pipe(image);

  try {
    for await (const chunk of image) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Sharp emitted an image chunk that was not bytes.');
      }
      yield chunk;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.off('error', onInputError);
    input.unpipe(image);
    input.destroy();
    image.destroy();
  }
}

/** Generic deterministic image rendition processor backed by Sharp/libvips. */
class SharpImageProcessor implements ArtifactProcessor {
  public readonly id = SHARP_IMAGE_PROCESSOR_ID;
  public readonly priority = SHARP_IMAGE_PROCESSOR_PRIORITY;
  public readonly version = SHARP_IMAGE_PROCESSOR_VERSION;

  public supports(source: ArtifactProcessorSource, profile: RepresentationProfile): boolean {
    const mediaType = outputMediaType(source, profile);
    return (
      INPUT_MEDIA_TYPES.has(source.mediaType) &&
      mediaType !== undefined &&
      validTransform(profile, mediaType) !== undefined
    );
  }

  public process(input: ArtifactProcessorInput): ArtifactProcessorOutput {
    const mediaType = outputMediaType(input.source, input.profile);
    const transform =
      mediaType === undefined ? undefined : validTransform(input.profile, mediaType);
    if (
      transform === undefined ||
      mediaType === undefined ||
      !INPUT_MEDIA_TYPES.has(input.source.mediaType)
    ) {
      throw new Error(
        `Sharp image processor cannot satisfy profile "${input.profile.id}" from ${input.source.mediaType}.`,
      );
    }

    return {
      data: renderedImage(input.source.stream, mediaType, transform, input.signal),
      mediaType,
    };
  }
}

export {
  MAX_IMAGE_DIMENSION,
  MAX_INPUT_PIXELS,
  SHARP_ENGINE_FINGERPRINT,
  SHARP_IMAGE_PROCESSOR_ID,
  SHARP_IMAGE_PROCESSOR_PRIORITY,
  SHARP_IMAGE_PROCESSOR_VERSION,
  SharpImageProcessor,
  sharpImageTransformSchema,
};

export type { SharpImageTransform, SharpOutputMediaType };
