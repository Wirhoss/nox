import { z } from 'zod';

import { builtinProvidersClasses } from '../provider';

import { readConfigFile } from './utils';

import type { EnvConfig } from './env';

const schemas = Object.values(builtinProvidersClasses).map(p => p.configSchema);

const providerIdSchema = z.string().regex(
  /^[a-zA-Z0-9_-]+$/,
  'Invalid provider ID'
);

const providerConfigSchema = z.discriminatedUnion(
  'type',
  schemas as [
    typeof schemas[number],
    ...typeof schemas[number][]
  ]
);

export const providersConfigSchema = z.record(
  providerIdSchema,
  providerConfigSchema
).refine(
  providers => Object.keys(providers).length > 0,
  'At least one provider must be configured.'
);

export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

let providersConfig: ProvidersConfig | null = null;

export async function getProvidersConfig(envConfig: EnvConfig) {
  try {
    if (!providersConfig) {
      providersConfig = providersConfigSchema.parse(await readConfigFile(envConfig.configFileProviders, {}));
    }
    return providersConfig;
  } catch (error) {
    throw new Error(`Error loading providers configuration: ${error}`);
  }
}