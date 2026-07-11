import type { ToolSetClass } from "../types";
import { FileSystemToolSet, ShellToolSet } from "./mocked";
import type { ToolSet } from "./tool";
import { ToolRouter } from "./toolRouter";

const builtinToolSets: Record<string, ToolSetClass> = {
  "tool_router": ToolRouter,
  "file_system": FileSystemToolSet,
  "shell": ShellToolSet,
  
}

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

  public getToolSet(toolSetId: string): ToolSet | null {
    const toolSetClass = this.toolSets[toolSetId];
    if (!toolSetClass) {
      return null;
    }
    return new toolSetClass();
  }
}