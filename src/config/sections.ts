import { toolsConfigSchema } from '../tool/config';
import { gateConfigSchema } from '../tool/gate';

import { appConfigSchema } from './app';
import { fileSection } from './section';

import type { SectionValue } from './section';

const sections = {
  app: fileSection({
    applies: 'restart',
    key: 'app',
    name: 'app.json',
    schema: appConfigSchema,
  }),
  gate: fileSection({
    applies: 'restart',
    key: 'gate',
    name: 'gate.json',
    schema: gateConfigSchema,
  }),
  tools: fileSection({
    applies: 'restart',
    key: 'tools',
    name: 'tools.json',
    schema: toolsConfigSchema,
  }),
};

type Sections = typeof sections;
type ConfigKey = keyof Sections;
type ConfigMap = { [K in ConfigKey]: SectionValue<Sections[K]> };

export {
  sections,
};

export type {
  ConfigKey,
  ConfigMap,
  Sections,
};
