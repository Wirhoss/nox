// import { z } from "zod";
// import type { Agent } from "./agent";

// const agentIdSchema = z.string().regex(
//   /^[a-zA-Z0-9_-]+$/,
//   "Invalid agent ID"
// );

// const agentBlueprintSchema = z.object({
//   id: z.string().describe("The id of the agent blueprint."),
//   description: z.string().describe("A brief description of the agent's purpose and capabilities."),
//   toolSets: z.array(z.string()).describe("The ids of the tools sets that the agent can use."),
//   systemPrompt: z.string().describe("The system prompt that defines the agent's behavior and personality."),
// });
 
// class AgentManager {
//   private static _instance: AgentManager;

//   private agents: Map<string, Agent> = new Map();
//   private agentBlueprints: Map<string, z.infer<typeof agentBlueprintSchema>> = new Map();

//   private initialized: boolean = false;

//   private constructor() {}

//   public static get instance(): AgentManager {
//     if (!AgentManager._instance) {
//       AgentManager._instance = new AgentManager();
//     }
//     return AgentManager._instance;
//   }

//   public async init(agentBlueprints: z.infer<typeof agentBlueprintSchema>[]): Promise<void> {
//     if (this.initialized) {
//       throw new Error("AgentManager already initialized.");
//     }
//     this.initialized = true;
//     for (const blueprint of agentBlueprints) {
//       this.agentBlueprints.set(blueprint.id, blueprint);
//     }
//   }

//   public registerAgent(agentBlueprintId: string, agentSessionId?: string): void {
//     const agentBlueprint = this.agentBlueprints.get(agentBlueprintId);
//     if (!agentBlueprint) {
//       throw new Error(`Agent blueprint with id ${agentBlueprintId} not found.`);
//     }
//     const agent = new Agent(
//       agentBlueprint.systemPrompt,
//       [],
//       agentBlueprint.toolSets.map((toolSetId) => {
//         // Assuming you have a method to get ToolSet by its ID
//         return this.getToolSetById(toolSetId);
//       })
//     );
//   }
// }