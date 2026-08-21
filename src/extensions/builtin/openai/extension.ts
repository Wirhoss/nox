import { providerContribution, providers } from '../../contribution-points/providers';
import { defineExtension } from '../../extension';
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
 */
const openAIExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.provider.openai' },
  activate(context) {
    context.contributions.register(
      providers,
      'openai_completions',
      providerContribution({
        configSchema: OpenAICompletions.configSchema,
        create: (config) => new OpenAICompletions(config, { logger: context.logger }),
      }),
    );
  },
});

export { openAIExtension };
