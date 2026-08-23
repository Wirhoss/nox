import { describe, expect, test } from 'bun:test';

import { probeArtifact } from './probe';

function isoBaseMediaFile(majorBrand: string, compatibleBrand: string): Uint8Array {
  return Buffer.concat([
    Uint8Array.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from(majorBrand),
    Uint8Array.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from(compatibleBrand),
  ]);
}

describe('probeArtifact image formats', () => {
  test('distinguishes AVIF and HEIF brands from ordinary MP4 containers', () => {
    expect(probeArtifact(isoBaseMediaFile('avif', 'mif1'), undefined, undefined).mediaType).toBe(
      'image/avif',
    );
    expect(probeArtifact(isoBaseMediaFile('mif1', 'heic'), undefined, undefined).mediaType).toBe(
      'image/heif',
    );
    expect(probeArtifact(isoBaseMediaFile('isom', 'mp42'), undefined, undefined).mediaType).toBe(
      'video/mp4',
    );
  });

  test('recognizes SVG, TIFF and BMP mechanically', () => {
    expect(
      probeArtifact(
        Buffer.from('<?xml version="1.0"?><!-- icon --><svg viewBox="0 0 1 1"></svg>'),
        undefined,
        undefined,
      ).mediaType,
    ).toBe('image/svg+xml');
    expect(
      probeArtifact(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), undefined, undefined).mediaType,
    ).toBe('image/tiff');
    expect(
      probeArtifact(Uint8Array.from([0x42, 0x4d, 0x00, 0x00]), undefined, undefined).mediaType,
    ).toBe('image/bmp');
  });

  test('uses image filename extensions only when bytes and declarations are silent', () => {
    expect(probeArtifact(new Uint8Array(), undefined, 'vector.svg').mediaType).toBe(
      'image/svg+xml',
    );
    expect(probeArtifact(new Uint8Array(), undefined, 'photo.avif').mediaType).toBe('image/avif');
  });
});
