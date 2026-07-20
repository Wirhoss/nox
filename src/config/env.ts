import { z } from 'zod';

const defaultConfigPath = '/etc/nox/config';
const defaultDataPath = '/var/lib/nox';

export const envConfigSchema = z.object({
  environment: z.enum(['development', 'test', 'production']),
  configFileApp: z.string(),
  configFileProviders: z.string(),
  configFileTools: z.string(),
  configDirBlueprints: z.string(),
  databaseFile: z.string(),
  uiDir: z.string(),
});

export type EnvConfig = z.infer<typeof envConfigSchema>;

let envConfig: EnvConfig | null = null;

export function getEnvConfig(): EnvConfig {
  if (!envConfig) {
    const envConfigUnparsed = {
      environment: process.env.NODE_ENV ?? 'development',
      configFileApp: process.env.CONFIG_FILE_APP ?? `${defaultConfigPath}/app.json`,
      configFileProviders: process.env.CONFIG_FILE_PROVIDERS ?? `${defaultConfigPath}/providers.json`,
      configFileTools: process.env.CONFIG_FILE_TOOLS ?? `${defaultConfigPath}/tools.json`,
      configDirBlueprints: process.env.CONFIG_DIR_BLUEPRINTS
        ?? process.env.CONFIG_DIR_BLUEPRINTS
        ?? `${defaultConfigPath}/blueprints`,
      databaseFile: process.env.DATABASE_FILE ?? `${defaultDataPath}/nox.db`,
      uiDir: process.env.UI_DIR ?? '/usr/share/nox/ui',
    };
    envConfig = envConfigSchema.parse(envConfigUnparsed);
  }
  return envConfig;
}
