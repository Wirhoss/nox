import { z } from 'zod';

import { type ConfigurableContribution, createContributionPoint } from '../contribution';

import type { Broker } from '../../gateway/broker';

/**
 * Configuration shared by every contributed broker kind. `agent` is the routing:
 * one configured broker instance carries the conversations of exactly one agent,
 * so two agents on the same transport are two instances rather than a routing
 * table nothing has asked for yet.
 *
 * `approvers` is authority, and it is deliberately empty by default. A transport
 * asserts who is speaking; it cannot decide who may approve a tool call. Until
 * this names someone, permission requests are not delivered through the
 * transport at all and are answered on another surface.
 */
const brokerBaseConfigSchema = z.object({
  agent: z.string().min(1),
  approvers: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().optional(),
});

/**
 * A configured broker instance names the contribution that builds it through
 * `type`, just as a configured provider or tool set does. Concrete brokers
 * extend this floor with the credentials and connection details they need.
 */
const brokerConfigSchema = brokerBaseConfigSchema.extend({ type: z.string() });

type BrokerConfig = z.infer<typeof brokerConfigSchema>;

type BrokerConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof brokerBaseConfigSchema.shape
>;

type BrokerContribution = ConfigurableContribution<BrokerConfigSchema, Broker>;

/** Preserves a concrete broker's schema at its declaration site. */
function brokerContribution<TSchema extends BrokerConfigSchema>(
  contribution: ConfigurableContribution<TSchema, Broker>,
): ConfigurableContribution<TSchema, Broker> {
  return contribution;
}

const brokers = createContributionPoint<BrokerContribution>('nox.brokers');

export { brokerBaseConfigSchema, brokerConfigSchema, brokerContribution, brokers };

export type { BrokerConfig, BrokerConfigSchema, BrokerContribution };
