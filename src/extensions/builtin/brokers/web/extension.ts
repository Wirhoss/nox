import {
  brokerBaseConfigSchema,
  brokerContribution,
  brokers,
  chatHubService,
  defineExtension,
  z,
} from '@nox/extension-api';

import { WebBroker } from './webBroker';

/**
 * Configuration for Nox's own browser transport.
 *
 * Owner authentication and selectable-agent behavior are declared as ordinary
 * contribution metadata. The host no longer imports this builtin or switches on
 * its type; another discovered package travels through the same contract.
 */
const webBrokerConfigSchema = brokerBaseConfigSchema.extend({
  type: z.literal('web'),
});

const webBrokerExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      brokers,
      'web',
      brokerContribution({
        configSchema: webBrokerConfigSchema,
        create: () => new WebBroker(context.services.get(chatHubService)),
        // Single by default, which is what reserves the name `web` for it: its
        // entry must be called exactly what the contribution is called.
        host: {
          authorization: 'owner',
          removable: false,
          selectableAgent: true,
        },
      }),
    );
  },
});

export default webBrokerExtension;
export { webBrokerConfigSchema, webBrokerExtension };
