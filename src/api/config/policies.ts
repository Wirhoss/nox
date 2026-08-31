import { brokers } from '@nox/extension-api';

import { assertBlueprintReferences, instanceRemovalReasons } from './blueprints';
import { assertBrokerReferences, brokerAgentRemovalReasons } from './brokers';

import type { Blueprint } from '../../config/blueprint';
import type { ConfigKey } from '../../config/sections';
import type { BlueprintContext } from './blueprints';
import type { BrokerConfig } from '@nox/extension-api';

/**
 * What a section insists on beyond its schema. Both halves are about the rest of
 * the installation rather than about the document, which is exactly why no
 * schema can express them: whether the things this entry names exist, and
 * whether anything else would break if it stopped existing.
 */
interface SectionPolicy {
  /**
   * Why this entry must stay. Empty means it may go. Each reason is a whole
   * sentence, because it is read by whoever is being told no.
   */
  readonly reasonsToKeep?: (entryId: string) => readonly string[];
  /**
   * Judged after parsing and before anything is written, inside the lock that
   * serializes configuration writes. Throwing leaves the entry as it was.
   */
  readonly validate?: (entryId: string, value: unknown) => Promise<void> | void;
  /** Judgement over a section written as one document, after schema parsing. */
  readonly validateSection?: (value: unknown) => Promise<void> | void;
}

type SectionPolicies = Partial<Record<ConfigKey, SectionPolicy>>;

/**
 * Every judgement the configuration surface makes, in one table. A table rather
 * than branches in the store: these are not exceptions to how configuration is
 * administered, they are what each section happens to require, and a section
 * with nothing to say gains a row the day it does — without the store learning
 * its name.
 *
 * The rows are two halves of one fact read from opposite ends: a blueprint may
 * not name a provider that does not exist, and a provider may not stop existing
 * while a blueprint names it. Keeping them side by side makes it obvious they
 * have to agree.
 */
function configPolicies(context: BlueprintContext): SectionPolicies {
  const { config } = context;

  return {
    blueprints: {
      reasonsToKeep: (agentId) => brokerAgentRemovalReasons(context, agentId),
      validate: async (agentId, value) =>
        assertBlueprintReferences(agentId, value as Blueprint, context),
    },
    brokers: {
      reasonsToKeep: (brokerId) => {
        const entry = config.get('brokers')[brokerId];
        if (entry === undefined) return [];
        const host = context.contributions.get(brokers, entry.type)?.value.host;
        return host?.removable === false
          ? [`Broker "${brokerId}" is part of the control plane; disable it instead.`]
          : [];
      },
      validate: (brokerId, value) => {
        assertBrokerReferences(brokerId, value as BrokerConfig, context);
      },
    },
    memories: {
      reasonsToKeep: (instanceId) => instanceRemovalReasons(config, 'memories', instanceId),
    },
    providers: {
      reasonsToKeep: (instanceId) => instanceRemovalReasons(config, 'providers', instanceId),
    },
    toolSets: {
      reasonsToKeep: (instanceId) => instanceRemovalReasons(config, 'toolSets', instanceId),
    },
  };
}

export { configPolicies };

export type { SectionPolicies, SectionPolicy };
