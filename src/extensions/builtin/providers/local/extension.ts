import {
  defineExtension,
  defineTranslationFragment,
  embeddingProviderContribution,
  embeddings,
  translationFragments,
} from '@nox/extension-api';

import { LocalEmbeddingProvider } from './localEmbeddingProvider';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';

/**
 * Models Nox runs itself, on the CPU of the machine it is installed on.
 *
 * Contributed as one instance and not several: an entry here is a set of
 * weights loaded into this process, and a second copy of the same model would
 * buy nothing but a second copy of its memory. Two different models are two
 * configured instances of two different kinds, which is what the singleton rule
 * already expresses.
 */
const localProviderExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.provider.local.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.provider.local',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.provider.local.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.provider.local',
      }),
    );
    context.contributions.register(
      embeddings,
      'local',
      embeddingProviderContribution({
        configSchema: LocalEmbeddingProvider.configSchema,
        create: (config) => new LocalEmbeddingProvider(config, { logger: context.logger }),
      }),
    );
  },
});

export default localProviderExtension;
export { localProviderExtension };
