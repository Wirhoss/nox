import {
  BaseProvider,
  defineExtension,
  providerBaseConfigSchema,
  providerContribution,
  providers,
  z,
} from '@nox/extension-api';

import type { EmbeddingCapable, EmbedRequest, EmbedResult, ModelKind } from '@nox/extension-api';

const configSchema = providerBaseConfigSchema.extend({
  type: z.literal('counting_test'),
});

/**
 * A provider that only embeds, with no model behind it.
 *
 * It exists to prove that a service which cannot chat is still an ordinary
 * provider — no second contribution point, no second section. Each text becomes
 * its own character counts, normalized: deterministic and dependency-free, so
 * the test asserts the contract rather than the quality of a real model.
 */
class CountingEmbedder extends BaseProvider implements EmbeddingCapable {
  static readonly dimensions = 4;

  public fetchModelIds(): Promise<string[]> {
    return Promise.resolve(['counting']);
  }

  public supports(kind: ModelKind): boolean {
    return kind === 'embedding';
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
      providers,
      'counting_test',
      providerContribution({
        configSchema,
        create: (config) => new CountingEmbedder(config),
      }),
    );
  },
});

export default countingEmbedderExtension;
export { countingEmbedderExtension };
