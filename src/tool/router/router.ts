import { BM25 } from '../../utils';
import { UnknownToolError } from '../error';
import { renderTool } from '../render';
import { asTextToolResponse } from '../response';
import { prepareTool, ToolSet } from '../tool';

import { callToolSchema, searchToolSchema } from './schema';

import type { MessageContent } from '../../provider';
import type { ToolEntry } from '../registry';
import type { Tool, ToolExecution } from '../tool';

class ToolRouter extends ToolSet {
  readonly #entriesByIndex: Record<number, string> = {};
  readonly #entries = new Map<string, ToolEntry>();
  readonly #bm25 = new BM25();

  constructor(entries: readonly ToolEntry[]) {
    super();

    for (const entry of entries) {
      this.#entries.set(entry.tool.name, entry);
      const index = this.#bm25.addDocument(ToolRouter.#buildDocument(entry.tool));
      this.#entriesByIndex[index] = entry.tool.name;
    }

    this.addTools();
  }

  protected override addTools(): void {
    const callTool: Tool<typeof callToolSchema> = {
      name: 'call_tool',
      description:
        'Call a tool returned by search_tool. The params field MUST be a normal JSON object '
        + 'whose values directly match the tool schema. Never wrap values inside another object.',
      parameters: callToolSchema,
      executionType: 'deferred',
      prepare: ({ name, params }) => this.prepareRouted(name, params),
    };

    this.registerTool(callTool);

    const searchTool: Tool<typeof searchToolSchema> = {
      name: 'search_tool',
      description:
        'Search for available tools by capability. Use this before calling a tool whose '
        + 'name or parameters you don\'t already know. Returns matching tools with their exact '
        + 'name, description and JSON parameter schema. Never guess a tool name or its parameters.',
      parameters: searchToolSchema,
      executionType: 'immediate',
      prepare: ({ query }) => ({
        type: 'immediate',
        title: `Search tools — ${query}`,
        run: async (): Promise<MessageContent[]> => {
          const rendered = this.search(query).map((entry) => renderTool(entry.tool));
          return asTextToolResponse({
            tools: rendered.join('\n--------------------------------------------------\n'),
          });
        },
      }),
    };

    this.registerTool(searchTool);
  }

  public entryFor(name: string): ToolEntry | undefined {
    return this.#entries.get(name);
  }

  public search(query: string): ToolEntry[] {
    const found: ToolEntry[] = [];

    for (const { docIndex, score } of this.#bm25.search(query)) {
      const name = this.#entriesByIndex[docIndex];
      if (score <= 0 || name === undefined) continue;

      const entry = this.#entries.get(name);
      if (entry !== undefined) found.push(entry);
    }

    return found;
  }

  public prepareRouted(name: string, params: string): ToolExecution {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new UnknownToolError(name);
    }

    let rawParams: unknown;
    try {
      rawParams = JSON.parse(params);
    } catch (error) {
      throw new SyntaxError(`Invalid JSON params for ${name}.`, { cause: error });
    }

    return prepareTool(entry.tool, rawParams);
  }

  static #buildDocument(tool: Tool): string {
    return [
      tool.name,
      tool.name,
      tool.description,
      ...Object.entries(tool.parameters.shape).flatMap(([name, param]) => [
        name,
        param.description ?? '',
      ]),
    ].join('\n');
  }
}

export {
  ToolRouter,
};
