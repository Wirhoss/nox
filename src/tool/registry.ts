import { ToolRouter } from './tools';

import type { ToolSetClass } from './tool';

const builtinToolSets: Record<string, ToolSetClass> = {
};

class ToolRegistry {
  private static _instance: ToolRegistry;

  private toolSetClasses: Record <string, ToolSetClass> = {
    ...builtinToolSets,
  };

  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): ToolRegistry {
    if (!ToolRegistry._instance) {
      ToolRegistry._instance = new ToolRegistry();
    }
    return ToolRegistry._instance;
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      throw new Error('ToolRegistry already initialized.');
    }
    this.initialized = true;
  }

  public getRouterToolSetClass(): ToolSetClass | null {
    const toolRouterClass = ToolRouter;
    if (!toolRouterClass) {
      return null;
    }
    return toolRouterClass;
  }

  public getToolSetClass(toolSetId: string): ToolSetClass | null {
    const toolSetClass = this.toolSetClasses[toolSetId];
    if (!toolSetClass) {
      return null;
    }
    return toolSetClass;
  }
}

export { ToolRegistry };