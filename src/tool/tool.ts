import { InvalidToolParamsError, UnknownToolError } from './error';

import type { MessageContent } from '../agent/context/message';
import type { z } from 'zod';

interface ToolContext {
  abortSignal: AbortSignal;
}

type ToolEffect =
  | 'authentication'
  | 'credential'
  | 'delete'
  | 'execute'
  | 'network'
  | 'payment'
  | 'privilege'
  | 'read'
  | 'upload'
  | 'write';

type ToolResourceKind = 'account' | 'command' | 'file' | 'payment' | 'url';

interface ToolResource {
  readonly kind: ToolResourceKind;
  readonly value: string;
}

interface ToolRisk {
  readonly effects: readonly ToolEffect[];
  readonly resources?: readonly ToolResource[];
  readonly reversible?: boolean;
  readonly volume?: number;
}

interface Tool<T extends z.ZodObject = z.ZodObject> {
  description: string;
  name: string;
  parameters: T;
  prepare(params: z.infer<T>): ToolExecution;
  risk?: ToolRisk;
}

interface ToolExecutionSubject {
  readonly params: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly toolSetId: string;
}

interface ExecutionBase {
  gateSubject?: ToolExecutionSubject;
  preview?: string;
  risk?: ToolRisk;
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

interface PreparedToolCall {
  readonly execution: ToolExecution;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Validation and preparation are side-effect free; only execution.run may act. */
function prepareToolCall(tool: Tool, rawParams: unknown): PreparedToolCall {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) {
    throw new InvalidToolParamsError(tool, parsed.error);
  }
  return { execution: tool.prepare(parsed.data), params: parsed.data };
}

function prepareTool(tool: Tool, rawParams: unknown): ToolExecution {
  return prepareToolCall(tool, rawParams).execution;
}

interface ToolSetGrant {
  readonly toolSet: ToolSet;
  readonly toolSetId: string;
}

abstract class ToolSet {
  readonly #name: string;
  readonly #description: string;

  readonly #enabledTools: ReadonlySet<string>;
  readonly #tools = new Map<string, Tool>();

  #visibleTools?: Readonly<Record<string, Tool>>;

  constructor(name: string, description: string, enabledTools?: readonly string[]) {
    this.#name = name;
    this.#description = description;
    this.#enabledTools = new Set(enabledTools ?? []);
  }

  public get description(): string {
    return this.#description;
  }

  public get name(): string {
    return this.#name;
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

export { prepareTool, prepareToolCall, ToolSet };

export type {
  DeferredExecution,
  ImmediateExecution,
  PreparedToolCall,
  Tool,
  ToolContext,
  ToolEffect,
  ToolExecution,
  ToolExecutionSubject,
  ToolResource,
  ToolResourceKind,
  ToolRisk,
  ToolSetClass,
  ToolSetFactory,
  ToolSetGrant,
};
