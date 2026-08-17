import { appConfigSchema } from './app';
import { fileSection, type SectionValue } from './section';

const sections = {
  app: fileSection({
    applies: 'restart',
    name: 'app.json',
    schema: appConfigSchema,
  }),
};

type Sections = typeof sections;

type ConfigKey = keyof Sections;

type ConfigMap = { [K in ConfigKey]: SectionValue<Sections[K]> };

export { sections };

export type { ConfigKey, ConfigMap, Sections };
