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
 * provider would be: nothing in the kernel imports `OpenAICompletions`.
 *
 * Its schema is handed over rather than validated here, so `providers.json` is
 * checked against exactly what the adapter accepts — an extension that parsed
 * its config privately would leave the file unvalidatable by anything but
 * itself. The credential is handed over for the same reason: `OPENAI_API_KEY`
 * is a shared name, and any adapter speaking to the same vendor merges into
 * one credential an operator fills once.
 *
 * Optional, because `baseUrl` is free: a private-network endpoint commonly
 * wants no credential at all, and requiring one would make every such
 * deployment look permanently misconfigured.
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
