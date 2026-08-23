import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import {
  MAX_IMAGE_DIMENSION,
  SHARP_ENGINE_FINGERPRINT,
  SHARP_IMAGE_PROCESSOR_ID,
  SHARP_IMAGE_PROCESSOR_VERSION,
  SharpImageProcessor,
} from './sharpImageProcessor';

import type { ArtifactByteSource, ArtifactProcessorSource } from '../../../../artifact';
import type { RepresentationProfile } from '../../../../artifact/representation';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#336699"/></svg>';

function source(
  stream: ReadableStream<Uint8Array>,
  mediaType: string,
  size: number,
): ArtifactProcessorSource & { readonly stream: ReadableStream<Uint8Array> } {
  return Object.freeze({
    blobHash: createHash('sha256').update(mediaType).digest('hex'),
    mediaType,
    size,
    stream,
  });
}

function profile(overrides: Partial<RepresentationProfile> = {}): RepresentationProfile {
  return {
    id: 'test.image',
    mediaTypes: ['image/png'],
    version: 1,
    ...overrides,
  };
}

async function bytesFrom(data: ArtifactByteSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const iterable = data instanceof Blob ? data.stream() : data;
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError('Expected image processing to reject with an Error.', { cause: error });
  }
  throw new Error('Expected image processing to reject.');
}

async function render(
  processor: SharpImageProcessor,
  data: string | Uint8Array,
  mediaType: string,
  requestedProfile: RepresentationProfile,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  const blob = new Blob([data]);
  const output = processor.process({
    profile: requestedProfile,
    ...(signal === undefined ? {} : { signal }),
    source: source(blob.stream(), mediaType, blob.size),
  });
  return { bytes: await bytesFrom(output.data), mediaType: output.mediaType };
}

describe('SharpImageProcessor', () => {
  test('declares a cache version tied to both Sharp and libvips', () => {
    const processor = new SharpImageProcessor();

    expect(processor.id).toBe(SHARP_IMAGE_PROCESSOR_ID);
    expect(processor.version).toBe(SHARP_IMAGE_PROCESSOR_VERSION);
    expect(processor.version).toContain(`sharp${sharp.versions.sharp}`);
    expect(processor.version).toContain(`vips${sharp.versions.vips}`);
    expect(processor.version).toEndWith(SHARP_ENGINE_FINGERPRINT);
  });

  test('supports image profiles without claiming unrelated or unsafe transforms', () => {
    const processor = new SharpImageProcessor();
    const svg = { blobHash: 'a'.repeat(64), mediaType: 'image/svg+xml', size: SVG.length };

    expect(processor.supports(svg, profile())).toBeTrue();
    expect(processor.supports({ ...svg, mediaType: 'text/html' }, profile())).toBeFalse();
    expect(processor.supports(svg, profile({ mediaTypes: ['application/pdf'] }))).toBeFalse();
    expect(processor.supports(svg, profile({ transform: { unknown: true } }))).toBeFalse();
    expect(
      processor.supports(svg, profile({ transform: { width: MAX_IMAGE_DIMENSION + 1 } })),
    ).toBeFalse();
    expect(
      processor.supports(svg, profile({ transform: { width: 512, withoutEnlargement: false } })),
    ).toBeFalse();
    expect(
      processor.supports(
        svg,
        profile({ transform: { fit: 'fill', height: 32, position: 'top', width: 32 } }),
      ),
    ).toBeFalse();
    expect(processor.supports(svg, profile({ transform: { background: '#fff' } }))).toBeFalse();
  });

  test('streams SVG into a metadata-free PNG rendition', async () => {
    const output = await render(new SharpImageProcessor(), SVG, 'image/svg+xml', profile());
    const metadata = await sharp(output.bytes).metadata();

    expect(output.mediaType).toBe('image/png');
    expect(metadata).toMatchObject({ format: 'png', height: 16, width: 32 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  test('resizes and converts deterministically according to a generic profile', async () => {
    const input = await sharp({
      create: { background: '#ff3366', channels: 4, height: 24, width: 48 },
    })
      .png()
      .toBuffer();
    const requested = profile({
      mediaTypes: ['image/webp'],
      transform: { fit: 'cover', height: 8, quality: 90, width: 8 },
    });
    const processor = new SharpImageProcessor();

    const first = await render(processor, input, 'image/png', requested);
    const second = await render(processor, input, 'image/png', requested);
    const metadata = await sharp(first.bytes).metadata();

    expect(first.mediaType).toBe('image/webp');
    expect(first.bytes).toEqual(second.bytes);
    expect(metadata).toMatchObject({ format: 'webp', height: 8, width: 8 });
  });

  test('stops before decoding when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel conversion'));

    const error = await rejection(
      render(new SharpImageProcessor(), SVG, 'image/svg+xml', profile(), controller.signal),
    );

    expect(error.message).toContain('cancel conversion');
  });

  test('rejects an image whose declared pixel area exceeds the safety limit', async () => {
    const oversized =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="1" height="1"/></svg>';

    const error = await rejection(
      render(new SharpImageProcessor(), oversized, 'image/svg+xml', profile()),
    );

    expect(error.message).toMatch(/pixel|limit|width/iu);
  });
});
