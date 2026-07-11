import { z } from "zod";

import { asTextToolResponse } from "../utils";

import { ToolBox } from "./../tool";
import { BM25 } from "./bm25";

import type { SyncTool, Tool, ToolResponse } from "../../types";

const searchToolSchema = z.object({
  query: z.string().describe("The query to search for the most relevant tool."),
});

const callToolSchema = z.object({
  name: z.string().describe("The name of the tool to call."),
  params: z.record(z.string(), z.any()).describe("The parameters to pass to the tool."),
});

class ToolRouter extends ToolBox {
  private registeredTools: Tool[] = [];
  private registeredToolsMap = new Map<string, Tool>();
  private bm25: BM25;

  constructor(tools: Tool[]) {
    super();
    this.registeredTools = tools;
    for (const tool of tools) {
      this.registeredToolsMap.set(tool.name, tool);
    }
    this.bm25 = new BM25(tools.map((tool) => this.buildBM25Document(tool)));

    const searchTool: SyncTool<typeof searchToolSchema> = {
      type: "sync",
      name: "search_tool",
      description: "Searches for the most relevant tool for a given query.",
      parameters: searchToolSchema,
      call: async (params) => {
        const { query } = params;
        const toolsFound = this.searchTool(query);
        return asTextToolResponse({
          tools: toolsFound.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters.toJSONSchema(),
          })),
        });
      }
    };

    this._tools[searchTool.name] = searchTool;

    const callTool: SyncTool<typeof callToolSchema> = {
      type: "sync",
      name: "call_tool",
      description: "Calls a registered tool with the given parameters.",
      parameters: callToolSchema,
      call: async (params) => {
        const { name, params: toolParams } = params;
        return this.callTool(name, toolParams);
      }
    };

    this._tools[callTool.name] = callTool;
  }

  private buildBM25Document(tool: Tool): string {
    return [
      tool.name,
      tool.name,
      tool.description,
      ...Object.entries(tool.parameters.shape).flatMap(([name, param]) => [
        name,
        param.description ?? "",
      ]),
    ].join("\n");
  }

  public searchTool(query: string): Tool[] {
    const toolsFound: Tool[] = [];
    for (const { docIndex, score } of this.bm25.search(query, 5)) {
      if (score > 0 && this.registeredTools[docIndex]) {
        toolsFound.push(this.registeredTools[docIndex]);
      }
    }
    return toolsFound;
  }

  public callTool(name: string, params: unknown): Promise<ToolResponse> {
    const tool = this.registeredToolsMap.get(name);
    if (!tool) {
      throw new Error(`Tool with name ${name} not found.`);
    }
    if (tool.type === "sync") {
      const parsedParams = tool.parameters.parse(params);
      return tool.call(parsedParams);
    } else { // TODO: handle async tools
      throw new Error(`Async tool with name ${name} cannot be called directly.`);
    }
  }
}

export {
  ToolRouter,
};