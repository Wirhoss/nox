import {
  defineExtension,
  defineTranslationFragment,
  memories,
  memoryContribution,
  modelAccessService,
  runtimeActivityService,
  translationFragments,
} from '@nox/extension-api';

import { semanticMemoryConfigSchema } from './config';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import { SemanticMemory } from './semanticMemory';
import { SemanticStore } from './store';

/** Contributes the long-term memory that ships with Nox. */
const semanticMemoryExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.memory.semantic.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.memory.semantic',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.memory.semantic.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.memory.semantic',
      }),
    );
    context.contributions.register(
      memories,
      'semantic',
      memoryContribution({
        capabilities: { inspection: true, tools: true },
        configSchema: semanticMemoryConfigSchema,
        create: (config) => {
          // Both models are taken here, so a reference to a provider that is
          // gone or a model it does not serve fails this memory while it is
          // being built, and shows up as a component reporting itself
          // unavailable rather than as a conversation that quietly forgets.
          const models = context.services.get(modelAccessService);
          // Asked for rather than required: without it the memory still runs,
          // deciding from its backlog and its ceiling alone. A host that cannot
          // say whether it is busy should cost this memory its best trigger,
          // not its ability to be built.
          const activity = context.services.tryGet(runtimeActivityService);
          const memory = new SemanticMemory({
            ...(activity === undefined ? {} : { activity }),
            chat: models.chat(config.extraction),
            contradictionDistance: config.contradictionDistance,
            dream: config.dream,
            embedding: models.embedding(config.embedding),
            logger: context.logger,
            // Forwarded only when set: an absent floor means "measure it",
            // which is not the same as a floor of undefined.
            ...(config.maxDistance === undefined ? {} : { maxDistance: config.maxDistance }),
            maxRecallFacts: config.maxRecallFacts,
            mergeDistance: config.mergeDistance,
            store: new SemanticStore(context.storage),
          });
          void memory.start();
          return memory;
        },
      }),
    );
  },
});

export default semanticMemoryExtension;
export { semanticMemoryExtension };
