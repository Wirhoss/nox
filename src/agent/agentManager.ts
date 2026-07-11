import { nanoid } from 'nanoid';
import { z } from "zod";

import { createLogger } from "../logger";
import { ProviderManager } from "../provider";
import { ToolManager } from "../tool";

import { Agent } from "./agent";

import type { ToolSet } from "../tool";

const logger = createLogger("agent");

const agentBlueprintSchema = z.object({
  id: z.string().regex(
    /^[a-zA-Z0-9_-]+$/,
    "Invalid agent blueprint ID"
  ).describe("The id of the agent blueprint."),
  description: z.string().describe("A brief description of the agent's purpose and capabilities."),
  systemPrompt: z.string().describe("The system prompt that defines the agent's behavior and personality."),
  coreTools: z.array(z.string()).describe("The ids of the core tools that the agent can use."),
  lazyLoadedTools: z.array(z.string()).describe("The ids of the tools that are loaded on demand when needed."),
  config: z.object({
    providerId: z.string().describe("The id of the provider to use for this agent."),
    modelId: z.string().describe("The id of the model to use for this agent."),
    maxIterations: z.number().int().positive().describe("The maximum number of iterations the agent can perform before stopping."),
  }).describe("The configuration for the agent, including provider and model information."),
});

class AgentManager {
  private static _instance: AgentManager;

  private agents: Map<string, {blueprintId: string, agent: Agent}> = new Map();
  private agentBlueprints: Map<string, z.infer<typeof agentBlueprintSchema>> = new Map();

  private initialized: boolean = false;

  private toolManager: ToolManager = ToolManager.instance;
  private providerManager = ProviderManager.instance;

  private constructor() {}

  public static get instance(): AgentManager {
    if (!AgentManager._instance) {
      AgentManager._instance = new AgentManager();
    }
    return AgentManager._instance;
  }

  private createToolSets(blueprintId: string, toolSetIds: string[]): ToolSet[] {
    const toolSets: ToolSet[] = [];
    for (const id of toolSetIds) {
      const ToolSetClass = this.toolManager.getToolSet(id);
      if (!ToolSetClass) {
        logger.warn(
          `Tool set "${id}" not found for agent blueprint "${blueprintId}", dropping it.`
        );
        continue;
      }
      toolSets.push(new ToolSetClass());
    }
    return toolSets;
  }

  public async init(agentBlueprints: z.infer<typeof agentBlueprintSchema>[]): Promise<void> {
    if (this.initialized) {
      throw new Error("AgentManager already initialized.");
    }
    this.initialized = true;
    for (const blueprint of agentBlueprints) {
      const parsed = agentBlueprintSchema.parse(blueprint);
      if (this.agentBlueprints.has(parsed.id)) {
        throw new Error(`Duplicate agent blueprint "${parsed.id}".`);
      }
      this.agentBlueprints.set(blueprint.id, parsed);
    }
  }

  public createAgent(agentBlueprintId: string): { agentId: string, agent: Agent } {
    const agentBlueprint = this.agentBlueprints.get(agentBlueprintId);
    if (!agentBlueprint) {
      throw new Error(`Agent blueprint with id ${agentBlueprintId} not found.`);
    }
    const coreToolSets = this.createToolSets(agentBlueprintId, agentBlueprint.coreTools);
    const lazyLoadedToolSets = this.createToolSets(agentBlueprintId, agentBlueprint.lazyLoadedTools);
    const toolRouter = this.toolManager.getRouterToolSetClass();
    if (!toolRouter) {
      throw new Error("Tool router not found, cannot create agent.");
    }
    coreToolSets.push(new toolRouter(lazyLoadedToolSets));

    const provider = this.providerManager.getProvider(agentBlueprint.config.providerId);
    if (!provider) {
      throw new Error(`Provider with id ${agentBlueprint.config.providerId} not found.`);
    }
    const model = provider.getModel(agentBlueprint.config.modelId);
    if (!model) {
      throw new Error(`Model with id ${agentBlueprint.config.modelId} not found in provider ${agentBlueprint.config.providerId}.`);
    }
    const agent = new Agent(
      agentBlueprint.systemPrompt,
      [],
      coreToolSets,
      {
        provider: provider,
        model: model,
        maxIterations: agentBlueprint.config.maxIterations,
      }
    );
    const agentId = nanoid();
    this.agents.set(agentId, { blueprintId: agentBlueprintId, agent: agent });
    return { agentId, agent };
  }
}

export { AgentManager }