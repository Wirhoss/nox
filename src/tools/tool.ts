import type { Tool } from "../types";

abstract class ToolSet {
  protected _tools: Record<string, Tool> = {};

  public get tools(): Record<string, Tool> {
    return this._tools;
  }
}

export { ToolSet };