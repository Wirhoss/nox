import { z } from 'zod';

import { type ConfigurableContribution, createContributionPoint } from '../contribution';

import type { Broker } from '../../gateway/broker';

/**
 * Who may use what, on this broker. The key is a sender ID the broker
 * authenticates; the values are authorities or wildcards over them.
 *
 * Grants live per broker because a principal only exists relative to the
 * authority that vouched for it: the issuer is this broker's configured ID, and
 * the same sender ID on another transport is a different person. There is no
 * global list for that reason, and no entry means no authority at all.
 *
 * A wildcard is dynamic on purpose. `nox.history.*` covers what that namespace
 * gains later, and whoever writes one is accepting exactly that; an explicit list
 * stays closed.
 */
const brokerSenderIdSchema = z.string().trim().min(1);

const brokerGrantsSchema = z.record(
  brokerSenderIdSchema,
  z.array(z.string().trim().min(1)).readonly(),
);

/**
 * A named conversation replaces authority with a secure default; only the
 * agent falls back to the broker's required base route. Transport-level ingress
 * filtering belongs to the concrete broker and never reaches this schema.
 */
const brokerConversationOverrideSchema = z.object({
  agent: z.string().min(1).optional(),
  grants: brokerGrantsSchema.prefault({}),
});

const brokerConversationsSchema = z.record(
  z.string().trim().min(1),
  brokerConversationOverrideSchema,
);

/**
 * Configuration shared by every contributed broker kind. `agent` is the routing:
 * every conversation this broker carries is answered by that agent.
 *
 * There is exactly one configured instance per transport, and that is not a
 * convention — a bot holds one connection per credential, so a second instance
 * of the same transport is not something an operator can have. The consequence
 * matters for security: **the instance cannot be the trust boundary**. One
 * instance reaches a private team channel and a public one alike, with one
 * issuer, one agent and one tool catalog, so a principal's grants reach every
 * channel the broker can see.
 *
 * Per-conversation overrides of `agent` and `grants` make the conversation the
 * execution boundary. Storage already models it: `conversations.agent_id` is
 * per conversation, not per broker.
 *
 * `grants` is authority and is deliberately empty by default. A transport owns
 * its ingress filtering before it emits an event; that is not Gate policy.
 */
const brokerBaseConfigSchema = z.object({
  agent: z.string().min(1),
  /**
   * Removed rather than ignored. It used to name people who could answer any
   * escalation on this transport; approval is now the originator's alone, and a
   * configuration that still lists approvers is describing a rule Nox no longer
   * has. Failing to load says so; dropping the key silently would not.
   */
  approvers: z
    .undefined({
      error:
        '"approvers" was removed. Only the principal whose run raised an escalation may ' +
        'approve it, and approval cannot be delegated. Use "grants" to give principals ' +
        'the authorities they need.',
    })
    .optional(),
  conversations: brokerConversationsSchema.prefault({}),
  enabled: z.boolean().optional(),
  grants: brokerGrantsSchema.prefault({}),
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

export {
  brokerBaseConfigSchema,
  brokerConfigSchema,
  brokerContribution,
  brokerConversationOverrideSchema,
  brokerConversationsSchema,
  brokerGrantsSchema,
  brokers,
};

export type { BrokerConfig, BrokerConfigSchema, BrokerContribution };
