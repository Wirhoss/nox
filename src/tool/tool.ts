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
  call: (params: z.infer<T>) => Promise<MessageContent[]>;
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

  public get tools(): Record<string, Tool> {
    return this._tools;
  }
}

type ToolSetClass<T extends ToolSet = ToolSet> = new (...args: any[]) => T;

export type {
  DeferredTool,
  ImmediateTool,
  Tool,
  ToolSetClass,
};

export {
  ToolSet,
}
