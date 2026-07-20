import { mkdir, readdir, unlink } from 'node:fs/promises';

import { z } from 'zod';

import { agentBlueprintSchema } from '../agent/registry';

import { readConfigDirectory } from './utils';

import type { AgentBlueprint } from '../agent/registry';
import type { EnvConfig } from './env';

export const agentsConfigSchema = z.array(agentBlueprintSchema);

export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

let agentsConfig: AgentsConfig | null = null;

export async function getAgentsConfig(envConfig: EnvConfig) {
  try {
    if (!agentsConfig) {
      agentsConfig = agentsConfigSchema.parse(await readConfigDirectory(envConfig.configDirAgents, []));
    }
    return agentsConfig;
  } catch (error) {
    throw new Error(`Error loading agents configuration: ${error}`, { cause: error });
  }
}

async function findBlueprintFile(dirPath: string, blueprintId: string): Promise<string | null> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) {
      continue;
    }
    const filePath = `${dirPath}/${dirent.name}`;
    try {
      const parsed = JSON.parse(await Bun.file(filePath).text()) as { id?: string };
      if (parsed?.id === blueprintId) {
        return filePath;
      }
    } catch {
      // Unparsable files are skipped at load time too.
    }
  }
  return null;
}

export async function upsertAgentConfig(
  envConfig: EnvConfig,
  blueprint: AgentBlueprint,
): Promise<AgentBlueprint> {
  const current = await getAgentsConfig(envConfig);
  const dirPath = envConfig.configDirAgents;
  await mkdir(dirPath, { recursive: true }).catch(() => {});

  const filePath = await findBlueprintFile(dirPath, blueprint.id) ?? `${dirPath}/${blueprint.id}.json`;
  await Bun.write(filePath, JSON.stringify(blueprint, null, 2));

  const index = current.findIndex(entry => entry.id === blueprint.id);
  if (index >= 0) {
    current[index] = blueprint;
  } else {
    current.push(blueprint);
  }
  return blueprint;
}

export async function deleteAgentConfig(envConfig: EnvConfig, blueprintId: string): Promise<void> {
  const current = await getAgentsConfig(envConfig);
  const index = current.findIndex(entry => entry.id === blueprintId);
  if (index < 0) {
    throw new Error(`Agent blueprint with id ${blueprintId} not found.`);
  }
  const filePath = await findBlueprintFile(envConfig.configDirAgents, blueprintId);
  if (filePath) {
    await unlink(filePath);
  }
  current.splice(index, 1);
}
