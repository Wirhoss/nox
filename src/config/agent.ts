import { agentBlueprintSchema } from "../agent/agentManager";
import { readConfigDirectory } from "./utils";
import { z } from "zod";
import type { EnvConfig } from "./env";

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
    throw new Error(`Error loading agents configuration: ${error}`);
  }
}
