import { FileSystemToolSet, ShellToolSet, ToolRouter } from "./tools";

import type { ToolSetClass } from "../types";

const builtinToolSets: Record<string, ToolSetClass> = {
  "file_system": FileSystemToolSet,
  "shell": ShellToolSet,
};

class ToolManager {
  private static _instance: ToolManager;

  private toolSets: Record <string, ToolSetClass> = {
    ...builtinToolSets,
  };

  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): ToolManager {
    if (!ToolManager._instance) {
      ToolManager._instance = new ToolManager();
    }
    return ToolManager._instance;
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      throw new Error("ToolManager already initialized.");
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

  public getToolSet(toolSetId: string): ToolSetClass | null {
    const toolSetClass = this.toolSets[toolSetId];
    if (!toolSetClass) {
      return null;
    }
    return toolSetClass;
  }
}

export { ToolManager };