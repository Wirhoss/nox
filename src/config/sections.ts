import {
  brokerConfigSchema,
  brokers,
  providerConfigSchema,
  providers,
  toolSetConfigSchema,
  toolSets,
} from '@nox/extension-api';

import { appConfigSchema } from './app';
import { blueprintSchema } from './blueprint';
import { contributionSection, directorySection, fileSection, type SectionValue } from './section';

/**
 * Every section Nox has, named once. The set is closed and typed on purpose:
 * `ConfigKey` is what gives every reader of configuration an exact type, and
 * nothing is gained by letting an extension add a section — what an extension
 * needs to configure is its own contributions, and those are entries inside a
 * section that already exists.
 */
const sections = {
  app: fileSection({
    applies: 'restart',
    name: 'app.json',
    presentation: {
      description: 'settings.sections.general.description',
      editor: 'app',
      group: 'machine',
      label: 'settings.sections.general.label',
      plural: 'settings.sections.general.plural',
      references: ['blueprints'],
      slug: 'general',
    },
    schema: appConfigSchema,
  }),
  blueprints: directorySection({
    applies: 'hot',
    entrySchema: blueprintSchema,
    name: 'blueprints',
    presentation: {
      description: 'settings.sections.agents.description',
      editor: 'blueprint',
      entrySummary: { description: ['description'], detail: ['provider', 'model'] },
      group: 'intelligence',
      inventory: 'toolSets',
      label: 'settings.sections.agents.label',
      plural: 'settings.sections.agents.plural',
      references: ['providers', 'toolSets'],
      slug: 'agents',
    },
  }),
  brokers: contributionSection({
    applies: 'hot',
    baseSchema: brokerConfigSchema,
    name: 'brokers.json',
    point: brokers,
    presentation: {
      description: 'settings.sections.brokers.description',
      editor: 'broker',
      entrySummary: { description: [], detail: ['type', 'agent'] },
      group: 'capabilities',
      label: 'settings.sections.brokers.label',
      plural: 'settings.sections.brokers.plural',
      references: ['blueprints'],
      slug: 'brokers',
    },
  }),
  providers: contributionSection({
    applies: 'hot',
    baseSchema: providerConfigSchema,
    name: 'providers.json',
    point: providers,
    presentation: {
      description: 'settings.sections.providers.description',
      editor: 'contribution',
      entrySummary: { description: ['baseUrl'], detail: ['type', 'defaultModel'] },
      group: 'intelligence',
      label: 'settings.sections.providers.label',
      plural: 'settings.sections.providers.plural',
      slug: 'providers',
    },
  }),
  toolSets: contributionSection({
    applies: 'hot',
    baseSchema: toolSetConfigSchema,
    name: 'toolsets.json',
    point: toolSets,
    presentation: {
      description: 'settings.sections.toolSets.description',
      editor: 'toolSet',
      entrySummary: { description: [], detail: ['type'] },
      group: 'capabilities',
      inventory: 'toolSets',
      label: 'settings.sections.toolSets.label',
      plural: 'settings.sections.toolSets.plural',
      slug: 'tool-sets',
    },
  }),
};

type Sections = typeof sections;

type ConfigKey = keyof Sections;

type ConfigMap = { [K in ConfigKey]: SectionValue<Sections[K]> };

export { sections };

export type { ConfigKey, ConfigMap, Sections };
