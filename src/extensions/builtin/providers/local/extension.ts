import { join } from 'node:path';

import {
  dataDirectoryService,
  defineExtension,
  defineTranslationFragment,
  providerContribution,
  providers,
  translationFragments,
} from '@nox/extension-api';

import { LocalProvider } from './localProvider';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';

/**
 * Models Nox runs itself, on the CPU of the machine it is installed on.
 *
 * Contributed as one instance and not several: an entry here is the set of
 * weights loaded into this process, and a second copy of the same engine would
 * buy nothing but a second copy of its memory. The singleton owns the `local`
 * entry ID, but remains unconfigured until an operator chooses a model to run.
 */
const localProviderExtension = defineExtension({
  activate(context) {
    const dataDirectory = context.services.tryGet(dataDirectoryService);
    // Under the data directory rather than beside the code: weights are state
    // this installation accumulated, not something it shipped with.
    const defaultCacheDirectory =
      dataDirectory === undefined ? undefined : join(dataDirectory, 'models');
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
      providers,
      'local',
      providerContribution({
        configSchema: LocalProvider.configSchema,
        create: (config) =>
          new LocalProvider(config, {
            ...(defaultCacheDirectory === undefined ? {} : { defaultCacheDirectory }),
            logger: context.logger,
          }),
      }),
    );
  },
});

export default localProviderExtension;
export { localProviderExtension };
