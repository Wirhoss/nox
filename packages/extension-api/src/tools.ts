import { z } from 'zod';

import type {
  ArtifactContentReader,
  ArtifactOutputPublisher,
  ArtifactResponseAttacher,
} from './artifacts.js';
import type { MessageContent, PrincipalRef } from './content.js';
import type { MaybePromise } from './core.js';

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
  /**
   * Describe what this call would do, without doing it.
   *
   * May return a promise: a tool whose package runs behind a boundary answers
   * over it. Nothing here is allowed to have an effect — preparation runs
   * before anyone has decided the call may happen at all.
   */
  prepare(params: z.infer<T>): MaybePromise<ToolExecution>;
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

/**
 * A prepared call as the host holds it.
 *
 * Deliberately not the object the tool returned. What a tool hands back is a
 * convenient shape for authoring — a record with closures on it — and closures
 * do not cross a process boundary. This carries the same information split into
 * the half that is data and the half that is an operation, so a host holding one
 * is holding something a transport could have built for it.
 *
 * The field names match `ToolExecution` on purpose: the descriptive half is the
 * same information under the same names, and a reader moving between the tool
 * that produced it and the runner that consumes it should not have to translate.
 */
interface PreparedCallBase {
  readonly gateSubject?: ToolExecutionSubject;
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly risk?: ToolRisk;
  readonly title: string;
}

interface PreparedImmediateCall extends PreparedCallBase {
  readonly type: 'immediate';
  run(ctx: ToolContext): Promise<MessageContent[]>;
}

interface PreparedDeferredCall extends PreparedCallBase {
  readonly type: 'deferred';
  run(ctx: ToolContext): Promise<{ ack: MessageContent[]; result: Promise<MessageContent[]> }>;
}

type PreparedToolCall = PreparedDeferredCall | PreparedImmediateCall;

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

/**
 * What a tool that produces artifacts has to tell the model about them.
 *
 * Named and exported rather than inlined, because the kernel renders tool
 * descriptions too and a second copy of this paragraph would drift from this
 * one without either side failing a test.
 */
const ARTIFACT_OUTPUT_NOTICE =
  'Output: Works with durable artifact references. Tool artifacts are not attached ' +
  'automatically; call artifact_attach with an artifact ID only when you decide the user ' +
  'should receive it. Do not encode file bytes as base64 or inline them in text.';

/**
 * A tool as anything that only reads one should see it: entirely data.
 *
 * The host renders tools, counts their tokens, indexes them for search and
 * sends them to a provider, and none of that needs the Zod object — it needs
 * the same conversion of it, over and over. So the conversion happens once,
 * here, and what travels afterwards is something a message could have carried.
 *
 * `description` already includes the artifact notice when the tool declares
 * artifact output, because every reader wants the description the model is
 * actually given, and a second caller deciding that for itself is how the two
 * halves of one description drift apart.
 */
interface ToolDeclaration {
  readonly authority: string;
  readonly description: string;
  readonly name: string;
  readonly output?: ToolOutputCapabilities;
  readonly parameters: JsonSchema;
  readonly risk?: ToolRisk;
  readonly trust?: 'trusted';
}

/**
 * Memoised per tool. `toolParametersSchema` builds a new object on every call,
 * and its callers are the ones that run most: the token estimator converts
 * every tool in the table each time it estimates.
 */
const declarations = new WeakMap<Tool, ToolDeclaration>();

function declareTool(tool: Tool): ToolDeclaration {
  const existing = declarations.get(tool);
  if (existing !== undefined) return existing;
  const declaration = Object.freeze({
    authority: tool.authority,
    description: toolDescription(tool),
    name: tool.name,
    ...(tool.output === undefined ? {} : { output: tool.output }),
    parameters: toolParametersSchema(tool),
    ...(tool.risk === undefined ? {} : { risk: tool.risk }),
    ...(tool.trust === undefined ? {} : { trust: tool.trust }),
  });
  declarations.set(tool, declaration);
  return declaration;
}

function toolDescription(tool: Tool): string {
  return tool.output?.artifacts === true
    ? `${tool.description}

${ARTIFACT_OUTPUT_NOTICE}`
    : tool.description;
}

const MAX_DEPTH = 3;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function typeName(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined)
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');

  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined) return unique(union.map((variant) => typeName(variant))).join(' | ');

  if (Array.isArray(schema.type)) {
    return unique(schema.type.map((type) => typeName({ ...schema, type }))).join(' | ');
  }

  if (schema.type === 'array') {
    const inner = typeName(schema.items ?? {});
    return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
  }

  return typeof schema.type === 'string' ? schema.type : 'unknown';
}

function placeholders(schema: JsonSchema, depth = 0): unknown {
  if (schema.properties !== undefined && depth < MAX_DEPTH) {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, property]) => [
        key,
        placeholders(property, depth + 1),
      ]),
    );
  }
  if (schema.type === 'array' && schema.items !== undefined && depth < MAX_DEPTH) {
    return [placeholders(schema.items, depth + 1)];
  }
  return `<${typeName(schema)}>`;
}

function paramDocs(schema: JsonSchema, prefix = ''): string[] {
  const lines: string[] = [];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = prefix.length > 0 ? `${prefix}.${name}` : name;

    if (property.description !== undefined && property.description.length > 0) {
      const fallback =
        property.default === undefined ? '' : ` (default: ${JSON.stringify(property.default)})`;
      lines.push(`- ${path}: ${property.description}${fallback}`);
    }

    const union = property.anyOf ?? property.oneOf;
    const inner =
      union?.find((variant) => variant.properties !== undefined || variant.items !== undefined) ??
      property;

    if (inner.properties !== undefined) lines.push(...paramDocs(inner, path));
    if (inner.items?.properties !== undefined) lines.push(...paramDocs(inner.items, `${path}[]`));
  }

  return lines;
}

/**
 * One tool as the model reads it.
 *
 * There was a second, poorer renderer here and a richer one in the kernel, and
 * which one a model saw depended on how it arrived: discovery showed the rich
 * form, and the error for invalid params answered with raw JSON Schema under a
 * heading that said "Expected signature". A model being corrected was being
 * corrected in a notation it had never been taught. One renderer, so the
 * signature in the error is the signature in the catalogue.
 */
function renderDeclaration(declaration: ToolDeclaration): string {
  const schema = declaration.parameters;
  const lines = [
    `Tool: ${declaration.name}`,
    `Description: ${declaration.description}`,
    `\nArguments: ${JSON.stringify(placeholders(schema), null, 2)}`,
  ];

  const docs = paramDocs(schema);
  if (docs.length > 0) {
    lines.push('\nParameters:', ...docs);
  }

  return lines.join('\n');
}

/** The same rendering, for a caller that still holds the tool itself. */
function renderTool(tool: Tool): string {
  return renderDeclaration(declareTool(tool));
}

/**
 * Validate raw params against a tool's schema, then prepare the call.
 *
 * Asynchronous although nothing here awaits, because this is the seam a tool
 * call crosses to reach the package that owns it. Today that package is in this
 * process; the shape is the one that survives when it is not, and it is far
 * cheaper to have callers awaiting a resolved promise now than to change every
 * caller later under a boundary that already exists.
 *
 * Validation deliberately stays on this side rather than moving into the host.
 * The schema belongs to the tool, so the only place that can check params
 * against it without carrying a second copy is here, beside the tool.
 */
async function prepareTool(tool: Tool, rawParams: unknown): Promise<ToolExecution> {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) throw new InvalidToolParamsError(tool, parsed.error);
  return tool.prepare(parsed.data);
}

async function prepareToolCall(tool: Tool, rawParams: unknown): Promise<PreparedToolCall> {
  const parsed = tool.parameters.safeParse(rawParams);
  if (!parsed.success) throw new InvalidToolParamsError(tool, parsed.error);
  const execution = await tool.prepare(parsed.data);
  const described = {
    ...(execution.gateSubject === undefined ? {} : { gateSubject: execution.gateSubject }),
    params: parsed.data as Readonly<Record<string, unknown>>,
    ...(execution.preview === undefined ? {} : { preview: execution.preview }),
    ...(execution.risk === undefined ? {} : { risk: execution.risk }),
    title: execution.title,
  };
  return Object.freeze(
    execution.type === 'deferred'
      ? { ...described, run: (ctx: ToolContext) => execution.run(ctx), type: 'deferred' as const }
      : { ...described, run: (ctx: ToolContext) => execution.run(ctx), type: 'immediate' as const },
  );
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
 * A tool as the session table holds it: what a reader needs, and one way in.
 *
 * The table used to hold `Tool` objects — Zod schema, `prepare` closure and
 * all. Nothing that reads the table ever wanted that: the provider, the token
 * estimator and the renderer want the declaration, and the runner wants to
 * prepare one call by name. Those are the two halves, and they are the two
 * halves a transport can carry.
 */
interface BoundTool {
  readonly declaration: ToolDeclaration;
  prepare(rawParams: unknown): Promise<PreparedToolCall>;
}

/**
 * Bind a declaration and its one way in to the set it was granted through.
 *
 * The binding is what produces the gate subject: a tool declares its authority
 * and its name, but only the table knows which configured set it arrived in,
 * and authorization is written against that pair. A call that already carries a
 * subject keeps it — that is how the router passes a routed tool's own subject
 * through instead of claiming the call as its own.
 *
 * One implementation, two ways to reach it, because a tool reaches the table
 * from two places: through a set that was granted, or as one of Nox's own tools
 * that belongs to no configured set at all.
 */
function bind(
  declaration: ToolDeclaration,
  toolSetId: string,
  prepare: (rawParams: unknown) => Promise<PreparedToolCall>,
): BoundTool {
  return Object.freeze({
    declaration,
    prepare: async (rawParams: unknown): Promise<PreparedToolCall> => {
      const prepared = await prepare(rawParams);
      if (prepared.gateSubject !== undefined) return prepared;
      const risk = mergeRisk(declaration.risk, prepared.risk);
      const stamped = {
        gateSubject: {
          authority: declaration.authority,
          ...(declaration.output === undefined ? {} : { output: declaration.output }),
          params: prepared.params,
          toolName: declaration.name,
          toolSetId,
          trust: declaration.trust ?? ('untrusted' as const),
        },
        ...(risk === undefined ? {} : { risk }),
      };
      return Object.freeze(
        prepared.type === 'deferred'
          ? { ...prepared, ...stamped, type: 'deferred' as const }
          : { ...prepared, ...stamped, type: 'immediate' as const },
      );
    },
  });
}

/** A tool that belongs to no configured set: Nox's own, handed over directly. */
function bindTool(source: Tool, toolSetId: string): BoundTool {
  return bind(declareTool(source), toolSetId, (rawParams) => prepareToolCall(source, rawParams));
}

/**
 * One tool of a granted set, reached only through the set.
 *
 * The host never touches the tool itself here — it reads a declaration and
 * calls `prepare` by name, which is exactly what it will do when the set is a
 * proxy for something running elsewhere.
 */
function bindSetTool(toolSet: ToolSet, name: string, toolSetId: string): BoundTool {
  const declaration = toolSet.declarations[name];
  if (declaration === undefined) throw new UnknownToolError(name);
  return bind(declaration, toolSetId, (rawParams) => toolSet.prepare(name, rawParams));
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
  #declared?: Readonly<Record<string, ToolDeclaration>>;
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

  /**
   * What this set exposes, as data.
   *
   * The half of `tools` that a host has any business reading. A set behind a
   * boundary answers this from a message; a set in this process answers it from
   * the tools it registered. Either way the caller sees the same thing, which
   * is the point of asking for it separately from `prepare`.
   */
  public get declarations(): Readonly<Record<string, ToolDeclaration>> {
    this.#declared ??= Object.freeze(
      Object.fromEntries(
        Object.entries(this.tools).map(([name, tool]) => [name, declareTool(tool)]),
      ),
    );
    return this.#declared;
  }

  public async prepare(name: string, rawParams: unknown): Promise<PreparedToolCall> {
    const tool = this.tools[name];
    if (tool === undefined) throw new UnknownToolError(name);
    return prepareToolCall(tool, rawParams);
  }

  protected abstract addTools(): void;

  protected registerTool(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered.`);
    this.#tools.set(tool.name, Object.freeze(tool));
    this.#declared = undefined;
    this.#visibleTools = undefined;
  }
}

type ToolSetClass<T extends ToolSet = ToolSet, TArguments extends unknown[] = []> = new (
  ...args: TArguments
) => T;
type ToolSetFactory<T extends ToolSet = ToolSet> = () => T;

export {
  ARTIFACT_OUTPUT_NOTICE,
  bindSetTool,
  bindTool,
  declareTool,
  InvalidToolParamsError,
  isToolError,
  prepareTool,
  prepareToolCall,
  renderDeclaration,
  renderTool,
  TOOL_OUTPUT_TRUST,
  toolDescription,
  ToolError,
  toolParametersSchema,
  ToolSet,
  UnknownToolError,
};

export type {
  BoundTool,
  DeferredExecution,
  ImmediateExecution,
  JsonSchema,
  PreparedDeferredCall,
  PreparedImmediateCall,
  PreparedToolCall,
  Tool,
  ToolContext,
  ToolDeclaration,
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
