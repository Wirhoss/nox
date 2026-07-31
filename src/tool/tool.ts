import { InvalidToolParamsError, UnknownToolError } from './error';

import type { MessageContent } from '../provider';
import type { GateDeclaration } from './gate';
import type { z } from 'zod';

interface ToolContext {
  abortSignal: AbortSignal;
}

type ToolExecutionType = 'immediate' | 'deferred';

type ToolExposure = 'eager' | 'lazy';

interface Tool<T extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  parameters: T;
  executionType: ToolExecutionType;
  exposure?: ToolExposure;
  prepare(params: z.infer<T>): ToolExecution;
}

interface ExecutionBase {
  title: string;
  preview?: string;
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

type ToolExecution =
  | ImmediateExecution
  | DeferredExecution;

function prepareTool(tool: Tool, rawParams: unknown): ToolExecution {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) {
    throw new InvalidToolParamsError(tool, parsed.error);
  }
  return tool.prepare(parsed.data);
}

abstract class ToolSet {
  public readonly exposure: ToolExposure;
  /** Rules this set ships with, applied before the user's own gate config. */
  public readonly gate?: GateDeclaration;
  readonly #tools = new Map<string, Tool>();
  readonly #enabledTools: ReadonlySet<string>;

  #visibleTools?: Readonly<Record<string, Tool>>;

  constructor(
    enabledTools?: readonly string[],
    exposure: ToolExposure = 'eager',
    gate?: GateDeclaration,
  ) {
    this.#enabledTools = new Set(enabledTools ?? []);
    this.exposure = exposure;
    this.gate = gate;
  }

  public get tools(): Readonly<Record<string, Tool>> {
    this.#visibleTools ??= Object.freeze(Object.fromEntries(
      [...this.#tools]
        .filter(([name]) => this.#enabledTools.size === 0 || this.#enabledTools.has(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    ));
    return this.#visibleTools;
  }

  public prepare(name: string, rawParams: unknown): ToolExecution {
    const tool = this.tools[name];
    if (tool === undefined) {
      throw new UnknownToolError(name);
    }
    return prepareTool(tool, rawParams);
  }

  protected registerTool(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered.`);
    }
    this.#tools.set(tool.name, Object.freeze(tool));
    this.#visibleTools = undefined;
  }

  protected abstract addTools(): void;
}

type ToolSetClass<T extends ToolSet = ToolSet, TArguments extends unknown[] = []> = new (...args: TArguments) => T;

type ToolSetFactory<T extends ToolSet = ToolSet> = () => T;

export type {
  DeferredExecution,
  ImmediateExecution,
  Tool,
  ToolContext,
  ToolExecution,
  ToolExecutionType,
  ToolExposure,
  ToolSetClass,
  ToolSetFactory,
};

export {
  prepareTool,
  ToolSet,
};
