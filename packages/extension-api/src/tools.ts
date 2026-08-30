import { z } from 'zod';

import type {
  ArtifactContentReader,
  ArtifactOutputPublisher,
  ArtifactResponseAttacher,
} from './artifacts.js';
import type { MessageContent, PrincipalRef } from './content.js';

interface ToolSessionContext {
  readonly agentId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The immutable principal whose message or command owns this tool execution. */
  readonly principal: PrincipalRef;
  readonly sessionId: string;
}

interface ToolContext {
  abortSignal: AbortSignal;
  artifactReader?: ArtifactContentReader;
  artifacts?: ArtifactOutputPublisher;
  responseAttachments?: ArtifactResponseAttacher;
  session?: ToolSessionContext;
  toolSetId?: string;
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
const TOOL_OUTPUT_TRUST = ['trusted', 'untrusted'] as const;
type ToolOutputTrust = (typeof TOOL_OUTPUT_TRUST)[number];

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

interface ToolOutputCapabilities {
  readonly artifacts?: true;
}

interface Tool<T extends z.ZodObject = z.ZodObject> {
  authority: string;
  description: string;
  name: string;
  output?: ToolOutputCapabilities;
  parameters: T;
  prepare(params: z.infer<T>): ToolExecution;
  risk?: ToolRisk;
  trust?: 'trusted';
}

interface ToolExecutionSubject {
  readonly authority: string;
  readonly output?: ToolOutputCapabilities;
  readonly params: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trust: ToolOutputTrust;
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
  run(ctx: ToolContext): Promise<{ ack: MessageContent[]; result: Promise<MessageContent[]> }>;
}

type ToolExecution = DeferredExecution | ImmediateExecution;

interface PreparedToolCall {
  readonly execution: ToolExecution;
  readonly params: Readonly<Record<string, unknown>>;
}

type ToolErrorCode = 'invalid_params' | 'unknown_tool';

class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly toolName: string;

  constructor(code: ToolErrorCode, toolName: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ToolError';
    this.code = code;
    this.toolName = toolName;
  }
}

class UnknownToolError extends ToolError {
  constructor(toolName: string) {
    super(
      'unknown_tool',
      toolName,
      `Tool "${toolName}" not found. Use tool_search to discover available tools.`,
    );
    this.name = 'UnknownToolError';
  }
}

class InvalidToolParamsError extends ToolError {
  constructor(tool: Tool, error: z.core.$ZodError, cause?: unknown) {
    super(
      'invalid_params',
      tool.name,
      `Invalid params for ${tool.name}:\n${z.prettifyError(error)}\n\n` +
        `Expected signature:\n${renderTool(tool)}\n\n` +
        'Param values must be plain JSON values (e.g. {"path": "/tmp"}), not wrapper objects.',
      cause,
    );
    this.name = 'InvalidToolParamsError';
  }
}

function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

interface JsonSchema {
  $schema?: string;
  anyOf?: JsonSchema[];
  const?: unknown;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
}

function toolParametersSchema(tool: Tool): JsonSchema {
  const { $schema: _draft, ...schema } = z.toJSONSchema(tool.parameters, { io: 'input' });
  return schema as JsonSchema;
}

function toolDescription(tool: Tool): string {
  const notice =
    'Output: Works with durable artifact references. Tool artifacts are not attached ' +
    'automatically; call artifact_attach with an artifact ID only when you decide the user ' +
    'should receive it. Do not encode file bytes as base64 or inline them in text.';
  return tool.output?.artifacts === true ? `${tool.description}\n\n${notice}` : tool.description;
}

function renderTool(tool: Tool): string {
  return (
    `Tool: ${tool.name}\nDescription: ${toolDescription(tool)}` +
    `\n\nParameters: ${JSON.stringify(toolParametersSchema(tool), null, 2)}`
  );
}

function prepareToolCall(tool: Tool, rawParams: unknown): PreparedToolCall {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) throw new InvalidToolParamsError(tool, parsed.error);
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
          ...(source.output === undefined ? {} : { output: source.output }),
          params,
          toolName: source.name,
          toolSetId,
          trust: source.trust ?? 'untrusted',
        },
        risk: mergeRisk(source.risk, execution.risk),
      };
    },
  });
}

interface ToolSetGrant {
  readonly toolSet: ToolSet;
  readonly toolSetId: string;
  readonly tools?: readonly string[];
}

abstract class ToolSet {
  readonly #description: string;
  readonly #enabledTools: ReadonlySet<string>;
  readonly #name: string;
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
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
    return this.#visibleTools;
  }

  public prepare(name: string, rawParams: unknown): ToolExecution {
    const tool = this.tools[name];
    if (tool === undefined) throw new UnknownToolError(name);
    return prepareTool(tool, rawParams);
  }

  protected abstract addTools(): void;

  protected registerTool(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered.`);
    this.#tools.set(tool.name, Object.freeze(tool));
    this.#visibleTools = undefined;
  }
}

type ToolSetClass<T extends ToolSet = ToolSet, TArguments extends unknown[] = []> = new (
  ...args: TArguments
) => T;
type ToolSetFactory<T extends ToolSet = ToolSet> = () => T;

export {
  bindTool,
  InvalidToolParamsError,
  isToolError,
  prepareTool,
  prepareToolCall,
  renderTool,
  TOOL_OUTPUT_TRUST,
  toolDescription,
  ToolError,
  toolParametersSchema,
  ToolSet,
  UnknownToolError,
};

export type {
  DeferredExecution,
  ImmediateExecution,
  JsonSchema,
  PreparedToolCall,
  Tool,
  ToolContext,
  ToolEffect,
  ToolErrorCode,
  ToolExecution,
  ToolExecutionSubject,
  ToolOutputCapabilities,
  ToolOutputTrust,
  ToolResource,
  ToolResourceKind,
  ToolRisk,
  ToolSessionContext,
  ToolSetClass,
  ToolSetFactory,
  ToolSetGrant,
};
