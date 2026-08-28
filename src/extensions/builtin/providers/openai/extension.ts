import {
  artifactPipelineService,
  defineExtension,
  defineTranslationFragment,
  providerContribution,
  providers,
  translationFragments,
} from '@nox/extension-api';

import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import { OpenAICompletions } from './openAICompletions';

/**
 * The OpenAI Chat Completions adapter, contributed the way any third-party
 * provider would be. Nothing in the kernel imports `OpenAICompletions`; it
 * arrives here and nowhere else.
 *
 * The adapter's own schema is handed over rather than validated in here: what a
 * valid config for it looks like is exactly what `providers.json` has to be
 * checked against, and the configuration module is the thing that reads that
 * file. An extension that parsed its config privately would leave the file
 * unvalidatable by anything but itself.
 *
 * The credential it needs is handed over for the same reason. `OPENAI_API_KEY`
 * is a shared name, not this extension's property: any other adapter speaking to
 * the same vendor declares the same ID and the two merge into one credential an
 * operator fills once. Naming it here is what makes it appear as something to
 * fill in before a provider is configured, rather than as a failed boot after.
 *
 * Optional, because `baseUrl` is free: an OpenAI-compatible endpoint on a
 * private network commonly wants no credential at all, and declaring the key
 * required would make every such deployment look permanently misconfigured.
 */
const openAIExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.provider.openai.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.provider.openai',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.provider.openai.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.provider.openai',
      }),
    );
    context.contributions.register(
      providers,
      'openai_completions',
      providerContribution({
        configSchema: OpenAICompletions.configSchema,
        // Several, on purpose: an instance here is the address of one endpoint,
        // and pointing two blueprints at two OpenAI-compatible services is the
        // ordinary reason this adapter exists.
        instances: 'many',
        create: (config) =>
          new OpenAICompletions(config, {
            artifacts: context.services.tryGet(artifactPipelineService),
            logger: context.logger,
          }),
      }),
    );
  },
});

export default openAIExtension;
export { openAIExtension };
