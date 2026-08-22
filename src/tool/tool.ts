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

/**
 * Every tool names the authority it needs, and there is no default. A tool that
 * did not say would otherwise be authorized against something invented for it —
 * which is a permission granted by accident, and the one thing this must never
 * do. An unnamed or unregistered authority is a configuration error, never an
 * allow.
 */
interface Tool<T extends z.ZodObject = z.ZodObject> {
  authority: string;
  description: string;
  name: string;
  parameters: T;
  prepare(params: z.infer<T>): ToolExecution;
  risk?: ToolRisk;
}

/**
 * What a prepared call is really about. A routed call arrives through the router
 * but is not a router call: the subject carries the tool that will actually run,
 * the set it came from, and the authority that tool declared. Authorization and
 * the Gate both read this rather than the name the model happened to type.
 */
interface ToolExecutionSubject {
  readonly authority: string;
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

function mergeRisk(
  declared: ToolRisk | undefined,
  prepared: ToolRisk | undefined,
): ToolRisk | undefined {
  if (declared === undefined) return prepared;
  if (prepared === undefined) return declared;
  return {
    effects: [...new Set([...declared.effects, ...prepared.effects])],
    resources: [...(declared.resources ?? []), ...(prepared.resources ?? [])],
    reversible: prepared.reversible ?? declared.reversible,
    volume: prepared.volume ?? declared.volume,
  };
}

/**
 * Ties a tool to the set it was granted from, so every execution it prepares
 * carries a subject. Nothing may run without one, so binding is not an
 * optimization — it is where the authority of a call becomes a fact rather than
 * a lookup.
 *
 * An execution that already has a subject is left exactly as it is. That is what
 * makes routing work — a routed tool prepared through the router has already
 * stamped its own name and authority, and the router must not overwrite them
 * with its own — and it is what makes binding idempotent, so a tool that passes
 * through two binders does not have its declared risk merged in twice.
 */
function bindTool(source: Tool, toolSetId: string): Tool {
  return Object.freeze({
    ...source,
    prepare: (params: Parameters<Tool['prepare']>[0]): ToolExecution => {
      const execution = source.prepare(params);
      if (execution.gateSubject !== undefined) return execution;

      return {
        ...execution,
        gateSubject: {
          authority: source.authority,
          params,
          toolName: source.name,
          toolSetId,
        },
        risk: mergeRisk(source.risk, execution.risk),
      };
    },
  });
}

interface ToolSetGrant {
  readonly toolSet: ToolSet;
  readonly toolSetId: string;
  /**
   * Which of the set's tools this grant carries. Absent grants all of them,
   * which is not the same as an empty list: the instance is shared by every
   * grant that names it, so the cut has to live here rather than on the set.
   */
  readonly tools?: readonly string[];
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

export { bindTool, prepareTool, prepareToolCall, ToolSet };

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
