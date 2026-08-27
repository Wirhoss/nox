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
    schema: appConfigSchema,
  }),
  blueprints: directorySection({
    applies: 'hot',
    entrySchema: blueprintSchema,
    name: 'blueprints',
  }),
  brokers: contributionSection({
    applies: 'hot',
    baseSchema: brokerConfigSchema,
    name: 'brokers.json',
    point: brokers,
  }),
  providers: contributionSection({
    applies: 'hot',
    baseSchema: providerConfigSchema,
    name: 'providers.json',
    point: providers,
  }),
  toolSets: contributionSection({
    applies: 'hot',
    baseSchema: toolSetConfigSchema,
    name: 'toolsets.json',
    point: toolSets,
  }),
};

type Sections = typeof sections;

type ConfigKey = keyof Sections;

type ConfigMap = { [K in ConfigKey]: SectionValue<Sections[K]> };

export { sections };

export type { ConfigKey, ConfigMap, Sections };
