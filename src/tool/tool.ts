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
  readonly #tools = new Map<string, Tool>();
  readonly #enabledTools: ReadonlySet<string>;

  #visibleTools?: Readonly<Record<string, Tool>>;

  constructor(enabledTools?: readonly string[]) {
    this.#enabledTools = new Set(enabledTools ?? []);
  }

  public readonly gate?: GateDeclaration;

  public get tools(): Readonly<Record<string, Tool>> {
    this.#visibleTools ??= Object.freeze(Object.fromEntries(
      [...this.#tools]
        .filter(([name]) => this.#enabledTools.size === 0 || this.#enabledTools.has(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    ));
    return this.#visibleTools;
  }

  protected registerTool(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }
    this.#tools.set(tool.name, Object.freeze({ ...tool }) as Tool);
    this.#visibleTools = undefined;
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
