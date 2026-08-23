import { z } from 'zod';

import { TOOL_CALL_AUTHORITY, TOOL_SEARCH_AUTHORITY } from '../auth/coreAuthorities';
import { BM25 } from '../utils/bm25';
import { stableStringify } from '../utils/json';
import { UnknownToolError } from './error';
import { renderTool } from './render';
import { prepareTool, type Tool, type ToolExecution, ToolSet } from './tool';

import type { MessageContent } from '../agent/context/message';

const ROUTER_TOOL_NAMES = Object.freeze(['call_tool', 'search_tool'] as const);
const ROUTER_TOOL_NAME_SET = new Set<string>(ROUTER_TOOL_NAMES);
const SEARCH_RESULT_LIMIT = 5;

const callToolSchema = z.object({
  name: z.string().min(1).describe('Exact tool name returned by search_tool.'),
  params: z
    .string()
    .describe(
      'A JSON string encoding one object whose values directly match the selected tool schema.',
    ),
});

const searchToolSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      "A short capability search (1-6 words). Examples: 'list files', 'read file', " +
        "'send email', 'postgres query'. Prefer one broad search instead of many narrow searches.",
    ),
});

function asTextToolResponse(value: unknown): MessageContent[] {
  return [{ text: stableStringify(value), type: 'text' }];
}

/**
 * Presents a fixed catalog through two direct tools instead of placing every
 * catalog schema in the request head. The JSON string boundary on call_tool is
 * intentional: small models follow it more consistently than a dynamic object
 * schema. The selected tool's real schema is still applied before execution.
 */
class ToolRouter extends ToolSet {
  readonly #bm25 = new BM25();
  readonly #toolsByIndex: Tool[] = [];
  readonly #toolsByName = new Map<string, Tool>();

  constructor(tools: readonly Tool[]) {
    super('tool_router', 'Searches and invokes tools from the routed tool catalog.');

    for (const source of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      if (ROUTER_TOOL_NAME_SET.has(source.name)) {
        throw new Error(`Routed tool ${source.name} conflicts with a tool router tool.`);
      }
      if (this.#toolsByName.has(source.name)) {
        throw new Error(`Routed tool ${source.name} is registered more than once.`);
      }

      const tool = Object.freeze({ ...source });
      this.#toolsByName.set(tool.name, tool);
      const index = this.#bm25.addDocument(ToolRouter.#buildDocument(tool));
      this.#toolsByIndex[index] = tool;
    }

    this.addTools();
  }

  public prepareRouted(name: string, params: string): ToolExecution {
    const tool = this.#toolsByName.get(name);
    if (tool === undefined) throw new UnknownToolError(name);

    let rawParams: unknown;
    try {
      rawParams = JSON.parse(params) as unknown;
    } catch (error) {
      throw new SyntaxError(`Invalid JSON params for ${name}.`, { cause: error });
    }

    return prepareTool(tool, rawParams);
  }

  public search(query: string): Tool[] {
    const found: Tool[] = [];

    for (const { docIndex, score } of this.#bm25.search(query, SEARCH_RESULT_LIMIT)) {
      const tool = this.#toolsByIndex[docIndex];
      if (score > 0 && tool !== undefined) found.push(tool);
    }

    return found;
  }

  protected override addTools(): void {
    const callTool: Tool<typeof callToolSchema> = {
      // Nominal only: `prepareRouted` returns the routed tool's own execution,
      // which already carries that tool's subject and authority. This is what an
      // unbound router would ask for, and nothing grants it.
      authority: TOOL_CALL_AUTHORITY,
      description:
        'Call a tool returned by search_tool. Pass params as a JSON string encoding one object ' +
        'whose values directly match that tool schema. Do not add wrapper objects.',
      name: 'call_tool',
      parameters: callToolSchema,
      prepare: ({ name, params }) => this.prepareRouted(name, params),
    };

    const searchTool: Tool<typeof searchToolSchema> = {
      authority: TOOL_SEARCH_AUTHORITY,
      description:
        'Search the routed tool catalog by capability. Returns matching tools with their exact ' +
        'names, descriptions, and parameter schemas. Use the returned schema before call_tool; ' +
        'never guess a routed tool name or its parameters.',
      name: 'search_tool',
      parameters: searchToolSchema,
      prepare: ({ query }) => ({
        run: () => {
          const rendered = this.search(query).map((tool) => renderTool(tool));
          return Promise.resolve(
            asTextToolResponse({
              tools: rendered.join('\n--------------------------------------------------\n'),
            }),
          );
        },
        title: `Search tools — ${query}`,
        type: 'immediate',
      }),
      // The rendered catalog is Nox describing its own tool table. It is the
      // same text that already sits unfenced in the request head for direct
      // tools, so fencing it here would only make one half of the tool table
      // look like somebody else's writing.
      trust: 'trusted',
    };

    this.registerTool(callTool);
    this.registerTool(searchTool);
  }

  static #buildDocument(tool: Tool): string {
    // renderTool includes nested parameter names and descriptions, so discovery
    // indexes the same contract that search_tool returns to the model.
    return [tool.name, tool.name, renderTool(tool)].join('\n');
  }
}

export { ROUTER_TOOL_NAMES, ToolRouter };
