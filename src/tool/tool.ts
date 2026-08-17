import { InvalidToolParamsError, UnknownToolError } from './error';

import type { MessageContent } from '../context/message';
import type { z } from 'zod';

interface ToolContext {
  abortSignal: AbortSignal;
}

interface Tool<T extends z.ZodObject = z.ZodObject> {
  description: string;
  name: string;
  parameters: T;
  prepare(params: z.infer<T>): ToolExecution;
}

interface ExecutionBase {
  preview?: string;
  title: string;
}

interface ImmediateExecution extends ExecutionBase {
  type: 'immediate';
  run(ctx: ToolContext): Promise<MessageContent[]>;
}

interface DeferredExecution extends ExecutionBase {
  type: 'deferred';
  run(ctx: ToolContext): Promise<{
    ack: MessageContent[];
    result: Promise<MessageContent[]>;
  }>;
}

type ToolExecution = DeferredExecution | ImmediateExecution;

function prepareTool(tool: Tool, rawParams: unknown): ToolExecution {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) {
    throw new InvalidToolParamsError(tool, parsed.error);
  }
  return tool.prepare(parsed.data);
}

abstract class ToolSet {
  readonly #enabledTools: ReadonlySet<string>;
  readonly #tools = new Map<string, Tool>();

  #visibleTools?: Readonly<Record<string, Tool>>;

  constructor(enabledTools?: readonly string[]) {
    this.#enabledTools = new Set(enabledTools ?? []);
  }

  public get tools(): Readonly<Record<string, Tool>> {
    this.#visibleTools ??= Object.freeze(
      Object.fromEntries(
        [...this.#tools]
          .filter(([name]) => this.#enabledTools.size === 0 || this.#enabledTools.has(name))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    return this.#visibleTools;
  }

  public prepare(name: string, rawParams: unknown): ToolExecution {
    const tool = this.tools[name];
    if (tool === undefined) {
      throw new UnknownToolError(name);
    }
    return prepareTool(tool, rawParams);
  }

  protected abstract addTools(): void;

  protected registerTool(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }
    this.#tools.set(tool.name, Object.freeze(tool));
    this.#visibleTools = undefined;
  }
}

type ToolSetClass<T extends ToolSet = ToolSet, TArguments extends unknown[] = []> = new (
  ...args: TArguments
) => T;

type ToolSetFactory<T extends ToolSet = ToolSet> = () => T;

export { prepareTool, ToolSet };

export type {
  DeferredExecution,
  ImmediateExecution,
  Tool,
  ToolContext,
  ToolExecution,
  ToolSetClass,
  ToolSetFactory,
};
