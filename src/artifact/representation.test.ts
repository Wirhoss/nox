import { describe, expect, test } from 'bun:test';

import {
  normalizeRepresentationProfile,
  profileAcceptsMediaType,
  profileAcceptsOriginal,
  representationProfileDigest,
} from './representation';

import type { ArtifactRecord } from './types';

const ARTIFACT: ArtifactRecord = Object.freeze({
  artifactId: 'art_12345678',
  blobHash: 'a'.repeat(64),
  createdAt: 1,
  mediaType: 'image/png',
  provenance: Object.freeze({ type: 'upload' }),
  scope: Object.freeze({ id: 'account-1', type: 'account' }),
  size: 12,
});

describe('representation profiles', () => {
  test('normalizes identity, media ranges and transform order into immutable data', () => {
    const normalized = normalizeRepresentationProfile({
      id: ' Consumer.Image ',
      mediaTypes: [' IMAGE/* ', 'image/png', 'IMAGE/*'],
      transform: { width: 512, quality: 80 },
      version: 1,
    });

    expect(normalized).toEqual({
      id: 'consumer.image',
      mediaTypes: ['image/*', 'image/png'],
      transform: { quality: 80, width: 512 },
      version: 1,
    });
    expect(Object.isFrozen(normalized)).toBeTrue();
    expect(Object.isFrozen(normalized.mediaTypes)).toBeTrue();
    expect(Object.isFrozen(normalized.transform)).toBeTrue();
  });

  test('fingerprints semantically identical profiles the same way', () => {
    const first = normalizeRepresentationProfile({
      id: 'test.consumer',
      mediaTypes: ['text/plain'],
      transform: { quality: 80, width: 512 },
      version: 1,
    });
    const second = normalizeRepresentationProfile({
      id: 'test.consumer',
      mediaTypes: ['text/plain'],
      transform: { width: 512, quality: 80 },
      version: 1,
    });

    expect(representationProfileDigest(first)).toBe(representationProfileDigest(second));
  });

  test('accepts exact and wildcard types but forces a processor for transforms or size limits', () => {
    const compatible = normalizeRepresentationProfile({
      id: 'test.image',
      maxBytes: 12,
      mediaTypes: ['image/*'],
      version: 1,
    });

    expect(profileAcceptsMediaType(compatible, 'image/png')).toBeTrue();
    expect(profileAcceptsMediaType(compatible, 'text/plain')).toBeFalse();
    expect(profileAcceptsOriginal(compatible, ARTIFACT)).toBeTrue();
    expect(
      profileAcceptsOriginal(
        normalizeRepresentationProfile({ ...compatible, maxBytes: 11 }),
        ARTIFACT,
      ),
    ).toBeFalse();
    expect(
      profileAcceptsOriginal(
        normalizeRepresentationProfile({ ...compatible, transform: { width: 512 } }),
        ARTIFACT,
      ),
    ).toBeFalse();
  });
});
