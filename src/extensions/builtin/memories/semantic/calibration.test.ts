import { describe, expect, test } from 'bun:test';

import { MemoryExtensionStorageProvider } from '../../../storage';
import {
  calibrateFloor,
  floorFromGroups,
  floorFromProbes,
  NEAREST_QUANTILE,
  PROBES,
} from './calibration';
import { SemanticStore } from './store';

import type { EmbeddingModel } from '@nox/extension-api';

/** Points on a line, so every nearest-neighbour distance is known by hand. */
function line(positions: readonly number[], scale = 1): readonly (readonly number[])[] {
  return positions.map((position) => [position * scale, 0]);
}

/**
 * Points spread evenly around a circle of the given radius.
 *
 * A geometry with a known answer: every distance follows from the radius alone,
 * so scaling the radius scales the whole distribution and nothing else about
 * the model changes.
 */
function ring(count: number, radius: number): readonly (readonly number[])[] {
  return Array.from({ length: count }, (_unused, index) => {
    const angle = (2 * Math.PI * index) / count;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

/** An embedder with a chosen geometry, standing in for a model with its own. */
function ringEmbedding(radius: number, calls: string[][] = []): EmbeddingModel {
  return {
    config: () => ({ dimensions: 2, kind: 'embedding', modelId: `ring-${String(radius)}` }),
    embed: (texts) => {
      calls.push([...texts]);
      return Promise.resolve({
        dimensions: 2,
        modelId: `ring-${String(radius)}`,
        vectors: ring(texts.length, radius),
      });
    },
    reference: { model: `ring-${String(radius)}`, provider: 'test' },
  };
}

describe('relevance floor calibration', () => {
  // Nearest neighbours are 1, 1, 1, 2 and 4; nine tenths of the way in is 3.2.
  const spread = [0, 1, 2, 4, 8];

  /**
   * High rather than low, because the floor's two mistakes cost different
   * amounts: a rejected answer is lost silently, an admitted irrelevance costs
   * a little budget. Pinned here so raising recall by loosening the floor stays
   * a deliberate change rather than something a later edit can undo unnoticed.
   */
  test('sits near the top of the nearest unrelated pairs, not the bottom', () => {
    expect(NEAREST_QUANTILE).toBe(0.9);
    expect(floorFromGroups([line(spread)])).toBeCloseTo(3.2, 6);
  });

  /**
   * The whole point of measuring rather than shipping a constant: under a model
   * whose vectors are three times as far apart, the same probes must produce a
   * floor three times as large. A hard-coded number cannot do this, and one
   * that did not scale would be a strict filter under one model and none at all
   * under another.
   */
  test('scales with the geometry of the model rather than staying fixed', async () => {
    const near = await calibrateFloor(ringEmbedding(1));
    const far = await calibrateFloor(ringEmbedding(3));

    expect(far / near).toBeCloseTo(3, 5);
  });

  /**
   * A model that compresses one group — as an English-trained model does to
   * Spanish — must not set the floor from the compressed one. That floor would
   * be strict enough to drop facts that answer the question in the language the
   * model handles well.
   */
  test('takes the floor from the most spread-out group, not the compressed one', () => {
    const compressed = line(spread, 0.1);
    const roomy = line(spread);

    expect(floorFromGroups([roomy, compressed])).toBeCloseTo(3.2, 6);
    expect(floorFromGroups([compressed, roomy])).toBeCloseTo(3.2, 6);
    expect(floorFromGroups([compressed])).toBeCloseTo(0.32, 6);
  });

  test('measures the probes and nothing an installation stored', async () => {
    const calls: string[][] = [];
    await calibrateFloor(ringEmbedding(1, calls));

    expect(calls).toEqual([[...PROBES]]);
  });

  test('refuses a model that places every probe in the same spot', () => {
    expect(() =>
      floorFromGroups([
        [
          [1, 0],
          [1, 0],
          [1, 0],
        ],
      ]),
    ).toThrow();
  });

  test('needs a pair before it has a distribution', () => {
    expect(() => floorFromGroups([[[1, 0]]])).toThrow();
  });

  test('refuses vectors that are not the probes it asked for', () => {
    expect(() => floorFromProbes(ring(3, 1))).toThrow();
  });
});

describe('stored calibration', () => {
  const identity = { dimensions: 2, model: 'ring-1', provider: 'test' };
  const calibration = {
    calibratedAt: '2026-08-29T00:00:00.000Z',
    floor: 1.31,
    pairs: 276,
    quantile: NEAREST_QUANTILE,
  };

  async function store(): Promise<SemanticStore> {
    const provider = new MemoryExtensionStorageProvider();
    return new SemanticStore(
      await provider.forExtension({
        extensionId: 'nox.memory.semantic',
        migrations: `${import.meta.dir}/migrations`,
      }),
    );
  }

  test('comes back for the model it was measured against', async () => {
    const semantic = await store();
    await semantic.saveCalibratedFloor(identity, calibration);

    expect((await semantic.calibratedFloor(identity))?.floor).toBe(1.31);
  });

  /** A floor is a statement about one geometry; another model must measure its own. */
  test('is not reused for a different model, provider or width', async () => {
    const semantic = await store();
    await semantic.saveCalibratedFloor(identity, calibration);

    expect(await semantic.calibratedFloor({ ...identity, model: 'ring-3' })).toBeUndefined();
    expect(await semantic.calibratedFloor({ ...identity, provider: 'other' })).toBeUndefined();
    expect(await semantic.calibratedFloor({ ...identity, dimensions: 4 })).toBeUndefined();
  });
});
