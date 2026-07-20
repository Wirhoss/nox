import { mkdir, readdir, unlink } from 'node:fs/promises';

import { z } from 'zod';

import { agentBlueprintSchema } from '../agent/registry';

import { readConfigDirectory } from './utils';

import type { AgentBlueprint } from '../agent/registry';
import type { EnvConfig } from './env';

export const blueprintsConfigSchema = z.array(agentBlueprintSchema);

export type BlueprintsConfig = z.infer<typeof blueprintsConfigSchema>;

let blueprintsConfig: BlueprintsConfig | null = null;

export async function getBlueprintsConfig(envConfig: EnvConfig) {
  try {
    if (!blueprintsConfig) {
      blueprintsConfig = blueprintsConfigSchema.parse(
        await readConfigDirectory(envConfig.configDirBlueprints, []),
      );
    }
    return blueprintsConfig;
  } catch (error) {
    throw new Error(`Error loading blueprints configuration: ${error}`, { cause: error });
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
      // Unparseable files are reported by configuration loading.
    }
  }
  return null;
}

export async function upsertBlueprintConfig(
  envConfig: EnvConfig,
  blueprint: AgentBlueprint,
): Promise<AgentBlueprint> {
  const current = await getBlueprintsConfig(envConfig);
  const dirPath = envConfig.configDirBlueprints;
  await mkdir(dirPath, { recursive: true });

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

export async function deleteBlueprintConfig(envConfig: EnvConfig, blueprintId: string): Promise<void> {
  const current = await getBlueprintsConfig(envConfig);
  const index = current.findIndex(entry => entry.id === blueprintId);
  if (index < 0) {
    throw new Error(`Blueprint with id ${blueprintId} not found.`);
  }
  const filePath = await findBlueprintFile(envConfig.configDirBlueprints, blueprintId);
  if (filePath) {
    await unlink(filePath);
  }
  current.splice(index, 1);
}
