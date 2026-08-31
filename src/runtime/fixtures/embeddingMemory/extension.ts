import {
  defineExtension,
  memories,
  memoryContribution,
  modelAccessService,
  modelReferenceSchema,
  z,
} from '@nox/extension-api';

import type { Memory } from '@nox/extension-api';

/**
 * A memory that reaches a configured embedding model.
 *
 * It exists to prove that an extension can use a model it did not contribute —
 * the thing a real memory needs before it can store anything semantic. What it
 * recalls is the vector itself, because that is the only way a test can see
 * from outside that the call went through the configured provider.
 */
const configSchema = z.object({
  embedding: modelReferenceSchema,
  type: z.literal('embedding_test'),
});

const embeddingMemoryExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      memories,
      'embedding_test',
      memoryContribution({
        configSchema,
        create: (config): Memory => {
          // Taken while the contribution is created, so a mistyped reference
          // fails the memory here rather than the first conversation using it.
          const embedding = context.services.get(modelAccessService).embedding(config.embedding);
          return {
            async recall(request) {
              const result = await embedding.embed([request.query], request.signal);
              return {
                memories: [
                  {
                    metadata: {
                      dimensions: result.dimensions,
                      modelId: result.modelId,
                      provider: embedding.reference.provider,
                    },
                    text: (result.vectors[0] ?? []).join(','),
                  },
                ],
              };
            },
            retain: () => undefined,
          };
        },
      }),
    );
  },
});

export default embeddingMemoryExtension;
export { embeddingMemoryExtension };
