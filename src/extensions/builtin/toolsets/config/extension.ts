import {
  authorities,
  configAdminService,
  defineExtension,
  defineTranslationFragment,
  secretStoreService,
  toolSetContribution,
  toolSets,
  translationFragments,
} from '@nox/extension-api';

import { ConfigToolSet } from './configToolSet';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import { CONFIG_READ_AUTHORITY, CONFIG_RUNTIME_AUTHORITY, CONFIG_WRITE_AUTHORITY } from './tools';

/** Contributes agent-facing administration over the same configuration boundary as Settings. */
const configToolsExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.toolset.config.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.toolset.config',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.toolset.config.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.toolset.config',
      }),
    );

    context.contributions.register(authorities, CONFIG_READ_AUTHORITY, {
      description: 'Read configured desired state, schemas, runtime status, and secret metadata.',
    });
    context.contributions.register(authorities, CONFIG_WRITE_AUTHORITY, {
      description: 'Create, replace, and delete configured desired state.',
    });
    context.contributions.register(authorities, CONFIG_RUNTIME_AUTHORITY, {
      description: 'Reload, retry, and revert runtime configuration activation.',
    });

    context.contributions.register(
      toolSets,
      'config',
      toolSetContribution({
        configSchema: ConfigToolSet.configSchema,
        create: (config) =>
          new ConfigToolSet(
            config,
            context.services.get(configAdminService),
            context.services.get(secretStoreService),
          ),
      }),
    );
  },
});

export default configToolsExtension;
export { configToolsExtension };
