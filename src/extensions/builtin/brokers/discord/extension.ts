import {
  artifactPipelineService,
  brokerContribution,
  brokers,
  defineExtension,
  defineTranslationFragment,
  translationFragments,
} from '@nox/extension-api';

import { discordBrokerConfigSchema, discordBrokerRuntimeConfigSchema } from './config';
import { DiscordBroker } from './discordBroker';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';

/**
 * Nox on Discord, contributed the way any third-party transport would be.
 * `authorization: 'grants'` is the declaration that matters here: one bot holds
 * one connection per credential and reaches every channel it can see under a
 * single issuer, so the instance cannot be the trust boundary. Who may use what
 * comes from `grants` — empty by default — and a `conversations` override makes
 * one channel a different boundary from another.
 *
 * The contribution keeps the single-instance policy, so its one entry is named
 * `discord`. A second bot would be a second contributed transport with its own
 * ID, not an arbitrary duplicate. `selectableAgent` is left off: a Discord
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
        // Parsed, not just passed through. An unset secret arrives as an absent
        // property rather than an explicit `undefined`, so the type says the
        // token is there while the object has no such key — and the failure
        // surfaces much later, as an unreadable one, deep inside the gateway
        // handshake. Rejecting it here is what lets `composeWithSecrets` name
        // the secret that is missing and where the configuration named it.
        // Parsing also narrows the entry to the broker's own shape: `agent`,
        // `grants` and `conversations` belong to the host, not to this.
        create: (config) =>
          new DiscordBroker(discordBrokerRuntimeConfigSchema.parse(config), {
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
