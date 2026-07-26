import { createLogger } from '../logger';

import { ToolRouter, WebTools } from './tools';

import type { ToolsConfig } from '../config/tools';
import type { Tool, ToolSet, ToolSetClass, ToolSetFactory } from './tool';

const logger = createLogger('tool');

class ToolRegistry {
  private static _instance: ToolRegistry;

  private toolSetFactories: Record<string, ToolSetFactory> = {};

  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): ToolRegistry {
    if (!ToolRegistry._instance) {
      ToolRegistry._instance = new ToolRegistry();
    }
    return ToolRegistry._instance;
  }

  public async init(config: ToolsConfig): Promise<void> {
    if (this.initialized) {
      throw new Error('ToolRegistry already initialized.');
    }
    this.toolSetFactories['web_tools'] = (): WebTools => new WebTools(config.web_tools ?? {});
    this.initialized = true;
    logger.info({ toolSets: Object.keys(this.toolSetFactories) }, 'Tool registry initialized.');
  }

  public getRouterToolSetClass(): ToolSetClass<ToolRouter, [Tool[]]> | null {
    const toolRouterClass = ToolRouter;
    if (!toolRouterClass) {
      return null;
    }
    return toolRouterClass;
  }

  public listToolSetIds(): string[] {
    return Object.keys(this.toolSetFactories);
  }

  public hasToolSet(toolSetId: string): boolean {
    return this.toolSetFactories[toolSetId] !== undefined;
  }

  public createToolSet(toolSetId: string): ToolSet | null {
    const factory = this.toolSetFactories[toolSetId];
    if (!factory) {
      return null;
    }
    return factory();
  }
}

export { ToolRegistry };
