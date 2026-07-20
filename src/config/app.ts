import { z } from 'zod';

import { gateConfigSchema } from '../gate';

import { readConfigFile } from './utils';

import type { GateConfig } from '../gate';
import type { EnvConfig } from './env';

export const appConfigSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  server: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }),

  gate: gateConfigSchema.default({ rules: [], escalationTimeoutMs: 120_000 }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

let appConfig: AppConfig | null = null;

export async function updateGateConfig(envConfig: EnvConfig, gate: GateConfig): Promise<GateConfig> {
  const parsed = gateConfigSchema.parse(gate);
  const raw = await readConfigFile<Record<string, unknown>>(envConfig.configFileApp, {});
  raw['gate'] = parsed;
  await Bun.write(envConfig.configFileApp, JSON.stringify(raw, null, 2));
  if (appConfig) {
    appConfig.gate = parsed;
  }
  return parsed;
}

export async function getAppConfig(envConfig: EnvConfig) {
  if (!appConfig) {
    const raw = await readConfigFile(envConfig.configFileApp, {
      logLevel: process.env.LOG_LEVEL ?? 'info',
      server: {
        host: process.env.HOST ?? '127.0.0.1',
        port: Number(process.env.PORT ?? 3000),
      },
    });
    appConfig = appConfigSchema.parse({
      ...raw,
      server: {
        ...raw.server,
        host: process.env.HOST ?? raw.server.host,
        port: process.env.PORT === undefined ? raw.server.port : Number(process.env.PORT),
      },
    });
  }
  return appConfig;
}
