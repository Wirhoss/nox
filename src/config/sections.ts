import { providerConfigSchema, providers } from '../extensions/contribution-points/providers';
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
    applies: 'restart',
    entrySchema: blueprintSchema,
    name: 'blueprints',
  }),
  providers: contributionSection({
    applies: 'restart',
    baseSchema: providerConfigSchema,
    name: 'providers.json',
    point: providers,
  }),
};

type Sections = typeof sections;

type ConfigKey = keyof Sections;

type ConfigMap = { [K in ConfigKey]: SectionValue<Sections[K]> };

export { sections };

export type { ConfigKey, ConfigMap, Sections };
