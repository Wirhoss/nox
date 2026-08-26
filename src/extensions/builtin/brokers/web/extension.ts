import { z } from 'zod';

import { WEB_BROKER_ID } from '../../../../api/chat/id';
import { chatHubService } from '../../../../services';
import {
  brokerBaseConfigSchema,
  brokerContribution,
  brokers,
} from '../../../contribution-points/brokers';
import { defineExtension } from '../../../extension';
import { WebBroker } from './webBroker';

/**
 * Configuration for Nox's own browser transport.
 *
 * `agent` is deliberately optional. One configured agent is unambiguous, an
 * explicit value is the preferred route, and a multi-agent installation without
 * one asks the operator when a new conversation is started.
 *
 * Web authenticates the installation owner through the HTTP control plane. The
 * common grants fields remain structurally present for the broker contribution
 * contract, but policy rejects values in them: pretending account authorization
 * came from sender IDs in brokers.json would create two conflicting trust models.
 */
const webBrokerConfigSchema = brokerBaseConfigSchema.extend({
  type: z.literal('web'),
});

const webBrokerExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.broker.web' },
  activate(context) {
    context.contributions.register(
      brokers,
      'web',
      brokerContribution({
        configSchema: webBrokerConfigSchema,
        create: () => new WebBroker(context.services.get(chatHubService)),
      }),
    );
  },
});

export { WEB_BROKER_ID, webBrokerConfigSchema, webBrokerExtension };
