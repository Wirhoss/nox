import {
  brokerBaseConfigSchema,
  brokerContribution,
  brokers,
  chatHubService,
  defineExtension,
  WEB_BROKER_ID,
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
        host: {
          authorization: 'owner',
          instanceId: WEB_BROKER_ID,
          selectableAgent: true,
        },
      }),
    );
  },
});

export default webBrokerExtension;
export { WEB_BROKER_ID, webBrokerConfigSchema, webBrokerExtension };
