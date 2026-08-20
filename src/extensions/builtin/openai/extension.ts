import { parseOrThrow } from '../../../utils/validate';
import { providers } from '../../contribution-points/providers';
import { defineExtension } from '../../extension';
import { OpenAICompletions, openAICompletionsConfigSchema } from './openAICompletions';

/**
 * The OpenAI Chat Completions adapter, contributed the way any third-party
 * provider would be. Nothing in the kernel imports `OpenAICompletions`; it
 * arrives here and nowhere else.
 */
const openAIExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.provider.openai' },
  activate(context) {
    context.contributions.register(providers, 'openai_completions', {
      create: (config) =>
        new OpenAICompletions(parseOrThrow(openAICompletionsConfigSchema, config), {
          logger: context.logger,
        }),
    });
  },
});

export { openAIExtension };
