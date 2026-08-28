import { type BrokerConfig, brokers } from '@nox/extension-api';

import type { BlueprintContext } from './blueprints';

/** A broker entry that would make the next gateway composition fail. */
class BrokerReferenceError extends Error {
  public readonly problems: readonly string[];

  constructor(brokerId: string, problems: readonly string[]) {
    super(`Broker "${brokerId}" cannot be saved: ${problems.join('; ')}.`);
    this.name = 'BrokerReferenceError';
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * Checks the cross-section routing and authority catalog that the broker's own
 * contributed schema cannot know about. Disabled brokers are not composed by
 * bootstrap, so their dormant routes and grants do not have to resolve yet.
 */
function assertBrokerReferences(
  brokerId: string,
  broker: BrokerConfig,
  context: BlueprintContext,
): void {
  if (broker.enabled === false) return;

  const problems: string[] = [];
  const blueprints = context.config.get('blueprints');
  const host = context.contributions.get(brokers, broker.type)?.value.host;
  const ownerAuthorized = host?.authorization === 'owner';
  const selectableAgent = host?.selectableAgent === true;

  if (!selectableAgent && broker.agent === undefined) {
    problems.push('a base agent is required for a transport that cannot ask the sender to choose');
  } else if (broker.agent !== undefined && !Object.hasOwn(blueprints, broker.agent)) {
    problems.push(`blueprints configures no base agent "${broker.agent}"`);
  }

  if (ownerAuthorized && Object.keys(broker.grants).length > 0) {
    problems.push('owner authority cannot be replaced with sender grants');
  } else {
    validateGrants(brokerId, 'base route', broker.grants, context, problems);
  }
  for (const [conversationId, override] of Object.entries(broker.conversations)) {
    if (override.agent !== undefined && !Object.hasOwn(blueprints, override.agent)) {
      problems.push(
        `conversation "${conversationId}" names agent "${override.agent}", which no blueprint defines`,
      );
    }
    if (ownerAuthorized && Object.keys(override.grants).length > 0) {
      problems.push(`conversation "${conversationId}" cannot replace owner authority with grants`);
    } else {
      validateGrants(
        brokerId,
        `conversation "${conversationId}"`,
        override.grants,
        context,
        problems,
      );
    }
  }

  if (problems.length > 0) throw new BrokerReferenceError(brokerId, problems);
}

/** Why an enabled broker still needs this blueprint. */
function brokerAgentRemovalReasons(context: BlueprintContext, agentId: string): readonly string[] {
  const reasons: string[] = [];
  for (const [brokerId, broker] of Object.entries(context.config.get('brokers'))) {
    if (broker.enabled === false) continue;
    if (broker.agent === agentId) {
      reasons.push(`brokers.json entry "${brokerId}" names it as its base agent.`);
    }
    for (const [conversationId, override] of Object.entries(broker.conversations)) {
      if (override.agent === agentId) {
        reasons.push(`brokers.json entry "${brokerId}" conversation "${conversationId}" names it.`);
      }
    }
  }
  return reasons.sort((a, b) => a.localeCompare(b));
}

function validateGrants(
  brokerId: string,
  route: string,
  grants: BrokerConfig['grants'],
  context: BlueprintContext,
  problems: string[],
): void {
  for (const [subject, patterns] of Object.entries(grants)) {
    for (const pattern of patterns) {
      try {
        context
          .authorities()
          .assertGrantPattern(pattern, `Principal "${brokerId}:${subject}" on ${route}`);
      } catch (error) {
        problems.push(error instanceof Error ? error.message.replace(/\.$/, '') : String(error));
      }
    }
  }
}

export { assertBrokerReferences, brokerAgentRemovalReasons, BrokerReferenceError };
