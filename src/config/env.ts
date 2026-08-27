import { join } from 'node:path';

import { z } from 'zod';

import { parseOrThrow } from '../utils/validate';

const DEFAULT_CONFIG_DIR = '/etc/nox/config';
const DEFAULT_DATA_DIR = '/var/lib/nox';
const DEFAULT_UI_DIR = '/app/ui';

const envConfigSchema = z.object({
  configDir: z.string().min(1),
  configWatch: z.boolean(),
  configWatchDebounceMs: z.number().int().min(50).max(60_000),
  dataDir: z.string().min(1),
  environment: z.enum(['development', 'production', 'test']),
  extensionsDir: z.string().min(1),
  uiDir: z.string().min(1),
});

type EnvConfig = z.infer<typeof envConfigSchema>;

type EnvSource = Readonly<Record<string, string | undefined>>;

function readEnvConfig(env: EnvSource = process.env): EnvConfig {
  const dataDir = env.DATA_DIR ?? DEFAULT_DATA_DIR;
  return parseOrThrow(envConfigSchema, {
    configDir: env.CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    configWatch: env.CONFIG_WATCH === '1' || env.CONFIG_WATCH === 'true',
    configWatchDebounceMs: Number(env.CONFIG_WATCH_DEBOUNCE_MS ?? 250),
    dataDir,
    environment: env.NODE_ENV ?? 'development',
    extensionsDir: env.EXTENSIONS_DIR ?? join(dataDir, 'extensions'),
    uiDir: env.UI_DIR ?? DEFAULT_UI_DIR,
  });
}

export { envConfigSchema, readEnvConfig };

export type { EnvConfig, EnvSource };
