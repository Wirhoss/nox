import { z } from "zod";

import { BM25 } from "../../../utils/bm25";
import { asTextToolResponse, renderTool } from "../../utils";

import { ToolSet } from "../../toolSet";

import type { SyncTool, Tool, ToolResponse } from "../../../types";

// NOTE, when we create the documentation we need to leave it clear that using this router does not work with all models the model needs to be trained with flexible tool calling, gemma 4 worked qwen 3.6 is broken

class ToolRouter extends ToolSet {
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

    const searchToolSchema = z.object({
      query: z.string().describe(
        "A short capability search (1-6 words). Examples: " +
        "'list files', 'read file', 'send email', 'postgres query'. " +
        "Prefer one broad search instead of many narrow searches."
      ),
    });

    const callToolSchema = z.object({
      name: z.string().describe(
        "Exact tool name returned by search_tool."
      ),
      params: z.string().describe(
        "JSON string containing the tool arguments."
      ),
    });

    const searchTool: SyncTool<typeof searchToolSchema> = {
      type: "sync",
      name: "search_tool",
      description:
        "Search for available tools by capability. Use this before calling a tool whose " +
        "name or parameters you don't already know. Returns matching tools with their exact " +
        "name, description and JSON parameter schema. Never guess a tool name or its parameters.",
      parameters: searchToolSchema,
      call: async (params) => {
        const { query } = params;
        const toolsFound = this.searchTool(query);
        const renderedTools = toolsFound.map((tool) => renderTool(tool));
        return asTextToolResponse({
          tools: renderedTools.join("\n--------------------------------------------------\n")
        });
      }
    };

    this._tools[searchTool.name] = searchTool;

    const callTool: SyncTool<typeof callToolSchema> = {
      type: "sync",
      name: "call_tool",
      description:
        "Call a tool returned by search_tool. The params field MUST be a normal JSON object " +
        "whose values directly match the tool schema. Never wrap values inside another object.",
      parameters: callToolSchema,
      call: async (_params) => {
        const { name, params } = _params;
        return this.callTool(name, params);
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
    for (const { docIndex, score } of this.bm25.search(query)) {
      if (score > 0 && this.registeredTools[docIndex]) {
        toolsFound.push(this.registeredTools[docIndex]);
      }
    }
    return toolsFound;
  }

  public callTool(name: string, params: string): Promise<ToolResponse> {
    params = JSON.parse(params);
    const tool = this.registeredToolsMap.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found. Use search_tool to discover available tools.`);
    }
    const parsed = tool.parameters.safeParse(params);
    if (!parsed.success) {
      throw new Error(
        `Invalid params for ${name}:\n${z.prettifyError(parsed.error)}\n\n` +
        `Expected signature:\n${renderTool(tool)}\n\n` +
        `Params values must be plain JSON values (e.g. {"path": "/tmp"}), not wrapper objects.`
      );
    }
    if (tool.type === "sync") {
      return tool.call(parsed.data);
    } else { // TODO: handle async tools
      throw new Error(`Async tool with name ${name} cannot be called directly.`);
    }
  }
}

export {
  ToolRouter,
};