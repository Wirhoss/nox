import {
  defineExtension,
  EmbeddingProvider,
  embeddingProviderConfigSchema,
  embeddingProviderContribution,
  embeddings,
  type EmbedRequest,
  type EmbedResult,
  z,
} from '@nox/extension-api';

const configSchema = embeddingProviderConfigSchema.extend({
  type: z.literal('counting_test'),
});

/**
 * An embedder with no model behind it: each text becomes its own character
 * counts, normalized. Deterministic and dependency-free, so a test can assert
 * the contract — batch order, declared dimensions, unit length — rather than
 * the quality of a real model.
 */
class CountingEmbedder extends EmbeddingProvider {
  static readonly dimensions = 4;

  public fetchModelIds(): Promise<string[]> {
    return Promise.resolve(['counting']);
  }

  public embed(request: EmbedRequest): Promise<EmbedResult> {
    request.signal?.throwIfAborted();
    return Promise.resolve({
      dimensions: CountingEmbedder.dimensions,
      modelId: request.modelId ?? 'counting',
      vectors: request.texts.map((text) => unit(counts(text))),
    });
  }
}

function counts(text: string): number[] {
  const buckets = Array.from({ length: CountingEmbedder.dimensions }, () => 0);
  for (const character of text) {
    const bucket = (character.codePointAt(0) ?? 0) % CountingEmbedder.dimensions;
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  return buckets;
}

function unit(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? [...vector] : vector.map((value) => value / length);
}

const countingEmbedderExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      embeddings,
      'counting_test',
      embeddingProviderContribution({
        configSchema,
        create: (config) => new CountingEmbedder(config),
      }),
    );
  },
});

export default countingEmbedderExtension;
export { countingEmbedderExtension };
