import {
  defineExtension,
  defineTranslationFragment,
  memories,
  memoryContribution,
  translationFragments,
} from '@nox/extension-api';

import { LocalMemory } from './localMemory';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';

/** Contributes the SQL-backed memory that ships with Nox. */
const localMemoryExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.memory.local.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.memory.local',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.memory.local.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.memory.local',
      }),
    );
    context.contributions.register(
      memories,
      'local',
      memoryContribution({
        configSchema: LocalMemory.configSchema,
        create: (config) => new LocalMemory(context.storage, config),
      }),
    );
  },
});

export default localMemoryExtension;
export { localMemoryExtension };
