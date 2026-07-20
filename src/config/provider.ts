import { z } from 'zod';

import { builtinProvidersClasses } from '../provider';

import { readConfigFile } from './utils';

import type { EnvConfig } from './env';

const schemas = Object.values(builtinProvidersClasses).map(p => p.configSchema);

export const providerIdSchema = z.string().regex(
  /^[a-zA-Z0-9_-]+$/,
  'Invalid provider ID'
);

export const providerConfigSchema = z.discriminatedUnion(
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
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

let providersConfig: ProvidersConfig | null = null;

export async function getProvidersConfig(envConfig: EnvConfig) {
  try {
    if (!providersConfig) {
      providersConfig = providersConfigSchema.parse(await readConfigFile(envConfig.configFileProviders, {}));
    }
    return providersConfig;
  } catch (error) {
    throw new Error(`Error loading providers configuration: ${error}`, { cause: error });
  }
}

export async function upsertProviderConfig(
  envConfig: EnvConfig,
  providerId: string,
  config: ProviderConfig,
): Promise<ProviderConfig> {
  const current = await getProvidersConfig(envConfig);
  const existing = current[providerId];

  if (config.apiKey === undefined && existing?.apiKey !== undefined) {
    config = { ...config, apiKey: existing.apiKey };
  } else if (config.apiKey === '') {
    config = { ...config };
    delete config.apiKey;
  }

  const parsed = providersConfigSchema.parse({ ...current, [providerId]: config });
  current[providerId] = parsed[providerId]!;
  await Bun.write(envConfig.configFileProviders, JSON.stringify(current, null, 2));
  return current[providerId]!;
}

export async function deleteProviderConfig(envConfig: EnvConfig, providerId: string): Promise<void> {
  const current = await getProvidersConfig(envConfig);
  if (!current[providerId]) {
    throw new Error(`Provider with id ${providerId} not found.`);
  }
  if (Object.keys(current).length <= 1) {
    throw new Error('At least one provider must remain configured.');
  }
  delete current[providerId];
  await Bun.write(envConfig.configFileProviders, JSON.stringify(current, null, 2));
}