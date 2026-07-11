import { z } from "zod";

import { readConfigFile } from "./utils";

import type { EnvConfig } from "./env";

export const appConfigSchema = z.object({
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

let appConfig: AppConfig | null = null;

export async function getAppConfig(envConfig: EnvConfig) {
  if (!appConfig) {
    appConfig = appConfigSchema.parse(await readConfigFile(envConfig.configFileApp, {
      logLevel: process.env.LOG_LEVEL ?? "info"
    }));
  }
  return appConfig;
}