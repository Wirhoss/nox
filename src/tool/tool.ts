import type { GateDeclaration } from '../gate';
import type { MessageContent } from '../provider';
import type { z } from 'zod';

interface ToolContext {
  abortSignal: AbortSignal;
}

interface ToolBase<T extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: T;
}

interface ImmediateTool<T extends z.ZodObject = z.ZodObject> extends ToolBase<T> {
  type: 'immediate';
  call: (params: z.infer<T>, ctx: ToolContext) => Promise<MessageContent[]>;
}

interface DeferredTool<T extends z.ZodObject = z.ZodObject> extends ToolBase<T> {
  type: 'deferred';
  start: (params: z.infer<T>, ctx: ToolContext) => Promise<{
    ack: string;
    result: Promise<MessageContent[]>;
  }>;
}

type Tool = ImmediateTool | DeferredTool;

abstract class ToolSet {
  protected _tools: Record<string, Tool> = {};
  protected enabledTools: Set<string>;

  constructor(enabledTools?: string[]) {
    this.enabledTools = new Set(enabledTools ?? []);
  }

  public readonly gate?: GateDeclaration;

  public get tools(): Record<string, Tool> {
    if (this.enabledTools.size === 0) {
      return this._tools;
    }
    const filteredTools: Record<string, Tool> = {};
    for (const tool of Object.values(this._tools)) {
      if (this.enabledTools.has(tool.name)) {
        filteredTools[tool.name] = tool;
      }
    }
    return filteredTools;
  }

  protected abstract addTools(): void;
}

type ToolSetClass<
  T extends ToolSet = ToolSet,
  TArguments extends unknown[] = [],
> = new (...args: TArguments) => T;

type ToolSetFactory<T extends ToolSet = ToolSet> = () => T;

export type {
  DeferredTool,
  ImmediateTool,
  Tool,
  ToolContext,
  ToolSetClass,
  ToolSetFactory,
};

export {
  ToolSet,
};
