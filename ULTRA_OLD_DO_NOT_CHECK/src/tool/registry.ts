import { createLogger } from '../logger';

import type { ToolsConfig } from './config';
import type { GateDeclaration } from './gate';
import type { Tool, ToolExposure, ToolSet, ToolSetFactory } from './tool';

const logger = createLogger('tool');

interface ToolEntry {
  tool: Tool;
  toolSetId: string;
  exposure: ToolExposure;
  gate?: GateDeclaration;
}

class ToolRegistry {
  static #instance?: ToolRegistry;

  #toolSetFactories: Record<string, ToolSetFactory> = {};

  public static get instance(): ToolRegistry {
    ToolRegistry.#instance ??= new ToolRegistry();
    return ToolRegistry.#instance;
  }

  public init(_config: ToolsConfig): void {
    //this.#toolSetFactories['web_tools'] = (): WebTools => new WebTools(config.web_tools ?? {});
    logger.info({ toolSets: Object.keys(this.#toolSetFactories) }, 'Tool registry initialized.');
  }

  public listToolSetIds(): string[] {
    return Object.keys(this.#toolSetFactories);
  }

  public hasToolSet(toolSetId: string): boolean {
    return this.#toolSetFactories[toolSetId] !== undefined;
  }

  public createToolSet(toolSetId: string): ToolSet | null {
    const factory = this.#toolSetFactories[toolSetId];
    if (!factory) {
      return null;
    }
    return factory();
  }

  public createEntries(toolSetIds?: readonly string[]): ToolEntry[] {
    const ids = toolSetIds ?? this.listToolSetIds();
    const entries: ToolEntry[] = [];

    for (const toolSetId of ids) {
      const toolSet = this.createToolSet(toolSetId);
      if (!toolSet) {
        logger.warn({ toolSetId }, 'Unknown tool set requested; skipping.');
        continue;
      }
      entries.push(...ToolRegistry.entriesOf(toolSet, toolSetId));
    }

    return entries;
  }

  public static entriesOf(toolSet: ToolSet, toolSetId: string): ToolEntry[] {
    return Object.values(toolSet.tools).map((tool) => ({
      tool,
      toolSetId,
      exposure: tool.exposure ?? toolSet.exposure,
      gate: toolSet.gate,
    }));
  }
}

export { ToolRegistry };

export type { ToolEntry };
