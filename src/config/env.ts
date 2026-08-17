import { z } from 'zod';

import { parseOrThrow } from '../utils/validate';

const DEFAULT_CONFIG_DIR = '/etc/nox/config';
const DEFAULT_DATA_DIR = '/var/lib/nox';

const envConfigSchema = z.object({
  configDir: z.string().min(1),
  dataDir: z.string().min(1),
  environment: z.enum(['development', 'production', 'test']),
});

type EnvConfig = z.infer<typeof envConfigSchema>;

type EnvSource = Readonly<Record<string, string | undefined>>;

function readEnvConfig(env: EnvSource = process.env): EnvConfig {
  return parseOrThrow(envConfigSchema, {
    configDir: env.CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    dataDir: env.DATA_DIR ?? DEFAULT_DATA_DIR,
    environment: env.NODE_ENV ?? 'development',
  });
}

export { envConfigSchema, readEnvConfig };

export type { EnvConfig, EnvSource };
