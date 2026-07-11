import { z } from "zod";

const defaultConfigPath = "/etc/nox/config";

export const envConfigSchema = z.object({
  environment: z.enum(["development", "test", "production"]),
  configFileApp: z.string(),
  configFileProviders: z.string(),
  configDirAgents: z.string(),
});

export type EnvConfig = z.infer<typeof envConfigSchema>;

let envConfig: EnvConfig | null = null;

export function getEnvConfig() {
  if (!envConfig) {
    const envConfigUnparsed = {
      environment: process.env.NODE_ENV ?? "development",
      configFileApp: process.env.CONFIG_FILE_APP ?? `${defaultConfigPath}/app.json`,
      configFileProviders: process.env.CONFIG_FILE_PROVIDERS ?? `${defaultConfigPath}/providers.json`,
      configDirAgents: process.env.CONFIG_DIR_AGENTS ?? `${defaultConfigPath}/agents`,
    };
    envConfig = envConfigSchema.parse(envConfigUnparsed);
  }
  return envConfig;
}