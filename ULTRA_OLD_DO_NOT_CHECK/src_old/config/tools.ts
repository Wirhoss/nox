import { z } from 'zod';

import { webToolsConfigSchema } from '../tool/tools';

import { readConfigFile } from './utils';

import type { WebToolsConfig } from '../tool/tools';
import type { EnvConfig } from './env';

export const toolsConfigSchema = z.object({
  web_tools: webToolsConfigSchema.optional(),
});

export type ToolsConfig = z.infer<typeof toolsConfigSchema>;

let toolsConfig: ToolsConfig | null = null;

export async function getToolsConfig(envConfig: EnvConfig): Promise<ToolsConfig> {
  if (!toolsConfig) {
    toolsConfig = toolsConfigSchema.parse(await readConfigFile(envConfig.configFileTools, {}));
  }
  return toolsConfig;
}

function mergeApiKey(
  next: { apiKey?: string },
  current: { apiKey?: string } | undefined,
): { apiKey?: string } {
  if (next.apiKey === undefined && current?.apiKey) {
    return { ...next, apiKey: current.apiKey };
  }
  if (next.apiKey === '') {
    const result = { ...next };
    delete result.apiKey;
    return result;
  }
  return next;
}

export async function updateWebToolsConfig(
  envConfig: EnvConfig,
  next: WebToolsConfig,
): Promise<WebToolsConfig> {
  const current = await getToolsConfig(envConfig);
  const previous = current.web_tools;
  const merged: WebToolsConfig = {
    ...(next.web_search ? {
      web_search: {
        ...next.web_search,
        serviceConfig: mergeApiKey(
          next.web_search.serviceConfig,
          previous?.web_search?.service === next.web_search.service
            ? previous.web_search.serviceConfig
            : undefined,
        ) as typeof next.web_search.serviceConfig,
      },
    } : {}),
    ...(next.web_extract ? {
      web_extract: {
        ...next.web_extract,
        serviceConfig: mergeApiKey(
          next.web_extract.serviceConfig,
          previous?.web_extract?.service === next.web_extract.service
            ? previous.web_extract.serviceConfig
            : undefined,
        ) as typeof next.web_extract.serviceConfig,
      },
    } : {}),
  };
  const parsed = webToolsConfigSchema.parse(merged);
  current.web_tools = parsed;
  await Bun.write(envConfig.configFileTools, JSON.stringify(current, null, 2));
  return parsed;
}
