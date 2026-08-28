import {
  artifactPipelineService,
  brokerContribution,
  brokers,
  defineExtension,
  defineTranslationFragment,
  translationFragments,
} from '@nox/extension-api';

import { discordBrokerConfigSchema } from './config';
import { DiscordBroker } from './discordBroker';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';

/**
 * Nox on Discord, contributed the way any third-party transport would be.
 *
 * `authorization: 'grants'` is the declaration that matters here. One bot holds
 * one connection per credential and reaches every channel it can see under a
 * single issuer, so the instance cannot be the trust boundary: who may use what
 * comes from `grants`, which is empty by default, and a `conversations` override
 * is what makes one channel a different boundary from another.
 *
 * The contribution keeps the default single-instance policy, so its one entry
 * is named `discord`, exactly like the contribution that owns it. A second bot
 * would be a second contributed transport with its own ID rather than an
 * arbitrary duplicate of this one. `selectableAgent` is left off: a Discord
 * conversation is a channel, and which agent answers it is a decision
 * configuration makes, not one a person picks per message.
 */
const discordBrokerExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.broker.discord.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.broker.discord',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.broker.discord.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.broker.discord',
      }),
    );

    context.contributions.register(
      brokers,
      'discord',
      brokerContribution({
        configSchema: discordBrokerConfigSchema,
        create: (config) =>
          new DiscordBroker(config, {
            logger: context.logger,
            // Optional on purpose: a Nox without an artifact pipeline still
            // carries conversations, it just carries them as text.
            pipeline: context.services.tryGet(artifactPipelineService),
          }),
        host: { authorization: 'grants' },
      }),
    );
  },
});

export default discordBrokerExtension;
export { discordBrokerExtension };
