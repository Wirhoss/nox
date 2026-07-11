import type { Tool } from "../types";

abstract class ToolBox {
  protected _tools: Record<string, Tool> = {};

  public get tools(): Record<string, Tool> {
    return this._tools;
  }
}

export { ToolBox };