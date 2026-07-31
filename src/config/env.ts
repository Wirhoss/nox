import { z } from 'zod';

const DEFAULT_CONFIG_DIR = '/etc/nox/config';
const DEFAULT_DATA_DIR = '/var/lib/nox';
const DEFAULT_UI_DIR = '/usr/share/nox/ui';

const envConfigSchema = z.object({
  configDir: z.string().min(1),
  dataDir: z.string().min(1),
  databaseFile: z.string().min(1),
  environment: z.enum(['development', 'production', 'test']),
  uiDir: z.string().min(1),
});

type EnvConfig = z.infer<typeof envConfigSchema>;
type EnvSource = Readonly<Record<string, string | undefined>>;

let cached: EnvConfig | undefined;

function readEnvConfig(env: EnvSource = process.env): EnvConfig {
  const dataDir = env['DATA_DIR'] ?? DEFAULT_DATA_DIR;

  return envConfigSchema.parse({
    configDir: env['CONFIG_DIR'] ?? DEFAULT_CONFIG_DIR,
    dataDir,
    databaseFile: env['DATABASE_FILE'] ?? `${dataDir}/nox.db`,
    environment: env['NODE_ENV'] ?? 'development',
    uiDir: env['UI_DIR'] ?? DEFAULT_UI_DIR,
  });
}

function getEnvConfig(): EnvConfig {
  cached ??= readEnvConfig();
  return cached;
}

export {
  envConfigSchema,
  getEnvConfig,
  readEnvConfig,
};

export type {
  EnvConfig,
  EnvSource,
};
