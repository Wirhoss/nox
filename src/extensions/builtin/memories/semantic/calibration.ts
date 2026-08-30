import type { EmbeddingModel } from '@nox/extension-api';

/**
 * Texts that have nothing to do with each other, used to ask an embedding model
 * where it puts two things that are unrelated.
 *
 * They are probes, not content: none of this is stored, recalled, or shown to
 * anyone. Each one is about a different subject — a kettle, basalt, storks, a
 * driving test — so the distance between any two is a sample from the
 * distribution the relevance floor exists to reject.
 */
const ENGLISH_PROBES: readonly string[] = Object.freeze([
  'The kettle in the third-floor kitchen stopped working last winter.',
  'Basalt cools quickly enough to trap gas bubbles near the surface.',
  'Interest rates were raised twice before the quarter closed.',
  'The manuscript was rebound in calfskin sometime in the 1840s.',
  'Migrating storks follow thermals rather than flapping across the strait.',
  'A submarine cable between the islands was cut by a trawler.',
  'The referee added six minutes for injuries at the end.',
  'Zinc plating protects the bolts until the coating is scratched.',
  'Rainfall this autumn was the lowest recorded since the station opened.',
  'The lighthouse log ends abruptly in September, mid-sentence.',
  'Bees navigate by polarized light when the sun is hidden.',
  'Sanding between coats is what makes the finish feel smooth.',
]);

const SPANISH_PROBES: readonly string[] = Object.freeze([
  'El tren de las siete llega con retraso los martes.',
  'La sopa lleva cilantro, lima y un poco de chile seco.',
  'El perro duerme debajo de la mesa cuando hace calor.',
  'La bicicleta necesita una cadena nueva y frenos ajustados.',
  'El concierto terminó antes de la última canción por la lluvia.',
  'Los zapatos de cuero se estiran después de una semana de uso.',
  'El acuerdo se firmó en una oficina prestada, sin testigos.',
  'La abuela guardaba las cartas en una caja de galletas.',
  'El examen de conducir se aprueba con treinta preguntas correctas.',
  'El museo cierra los lunes salvo en agosto.',
  'El alquiler subió doscientos euros al renovar el contrato.',
  'La reunión se movió al jueves porque nadie podía el lunes.',
]);

/**
 * The probes, grouped by the language they are written in.
 *
 * The grouping is not decoration. A model trained mostly on one language packs
 * the others into a narrower region of the space: measured on
 * `all-MiniLM-L6-v2`, unrelated English pairs sit at 1.20 and up while
 * unrelated Spanish pairs start at 0.90 and never reach 1.16. Mixed together
 * they form one distribution with two humps, and any quantile of it describes
 * neither language. Measured apart, each says what unrelated costs in the
 * language it was written in, and the floor can be chosen knowing both.
 */
const PROBE_GROUPS: readonly (readonly string[])[] = Object.freeze([
  ENGLISH_PROBES,
  SPANISH_PROBES,
]);

/** Every probe in one list, because calibration is a single embedding call. */
const PROBES: readonly string[] = Object.freeze(PROBE_GROUPS.flat());

/**
 * Where among a group's nearest unrelated pairs the floor is placed. High,
 * because the floor's two mistakes do not cost the same: rejecting a fact that
 * answered loses the answer silently and for good, while admitting an unrelated
 * one costs a few tokens and a model that ignores it. The top of the
 * nearest-unrelated distribution, not the bottom, because the two overlap —
 * anchored to the beginning, every genuine match sitting in the overlap is cut
 * off. Measured against `LFM2.5-Embedding-350M`, the bottom quarter cost 21
 * points of recall to save half a fact of budget; the top keeps recall complete.
 * Not the maximum: one outlying pair among twelve probes would make it mean
 * nothing. Rerun `bun run eval:retrieval` and `bun run eval:quantile` before
 * changing it.
 */
const NEAREST_QUANTILE = 0.9;

/** Below two probes there is no pair, and no distribution to take a quantile of. */
const MINIMUM_PROBES = 2;

/**
 * The straight-line distance `vec0` ranks by.
 *
 * Computed on the vectors exactly as the model returns them, unnormalized, so
 * the floor comes out in the units the store compares in. A model whose vectors
 * are not unit length is then calibrated correctly instead of being measured on
 * one scale and filtered on another.
 */
function distance(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    total += (value - other) ** 2;
  }
  return Math.sqrt(total);
}

/** Linear interpolation between the two samples the quantile falls between. */
function quantile(sorted: readonly number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/**
 * How close this model puts a thing to the nearest unrelated thing.
 *
 * Each probe's distance to its nearest neighbour rather than every pairwise
 * distance, because that is the shape a recall has: the store returns the
 * closest fact it holds, so the quantity worth knowing is how close the closest
 * unrelated one gets.
 */
function nearestWithin(vectors: readonly (readonly number[])[]): readonly number[] {
  return vectors
    .map((left, index) =>
      Math.min(
        ...vectors.flatMap((right, other) => (other === index ? [] : [distance(left, right)])),
      ),
    )
    .sort((left, right) => left - right);
}

/**
 * The relevance floor implied by groups of mutually unrelated vectors.
 *
 * The largest group floor wins, and that is the reason the groups exist. A
 * model that compresses one language would otherwise set the floor from the
 * compressed group and filter the other one down to nothing, dropping facts
 * that do answer the question. Taking the maximum leaves the filter as strict
 * as the most spread-out group allows and simply does less for the compressed
 * one, which costs context budget rather than answers.
 */
function floorFromGroups(
  groups: readonly (readonly (readonly number[])[])[],
  fraction: number = NEAREST_QUANTILE,
): number {
  const floors = groups.flatMap((vectors) =>
    vectors.length < MINIMUM_PROBES ? [] : [quantile(nearestWithin(vectors), fraction)],
  );
  if (floors.length === 0) {
    throw new Error('Calibrating a relevance floor needs a group of at least two probes.');
  }

  const floor = Math.max(...floors);
  if (!Number.isFinite(floor) || floor <= 0) {
    throw new Error('The embedding model placed every probe in the same place.');
  }
  return floor;
}

/** Splits one embedding call back into the groups it was assembled from. */
function floorFromProbes(vectors: readonly (readonly number[])[]): number {
  if (vectors.length !== PROBES.length) {
    throw new Error('The embedding model returned a vector for something other than the probes.');
  }

  let offset = 0;
  const groups = PROBE_GROUPS.map((group) => {
    const slice = vectors.slice(offset, offset + group.length);
    offset += group.length;
    return slice;
  });
  return floorFromGroups(groups);
}

/**
 * Asks the configured embedding model where its unrelated pairs sit.
 *
 * One call of two dozen short texts, paid once per model an installation ever
 * uses, and the answer is a single number kept beside the vectors it describes.
 * It replaces a constant that was measured against one model and shipped to
 * every other one, where the same value means whichever fraction of that
 * model's space it happens to land on.
 */
async function calibrateFloor(embedding: EmbeddingModel, signal?: AbortSignal): Promise<number> {
  const embedded = await embedding.embed(PROBES, signal);
  return floorFromProbes(embedded.vectors);
}

export { calibrateFloor, floorFromGroups, floorFromProbes, NEAREST_QUANTILE, PROBE_GROUPS, PROBES };
