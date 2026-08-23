import { z } from 'zod';

import type { JsonSchema } from '../utils/jsonSchema';
import type { Tool } from './tool';

const MAX_DEPTH = 3;
const ARTIFACT_OUTPUT_NOTICE =
  'Output: Works with durable artifact references. Tool artifacts are not attached automatically; ' +
  'call present_artifact with an artifact ID only when you decide the user should receive it. ' +
  'Do not encode file bytes as base64 or inline them in text.';

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
 * A tool's parameters as the model receives them. The `$schema` draft URL that
 * `z.toJSONSchema` emits is dropped on the way out: no provider reads it, and
 * repeating one constant URL per tool spends request-head tokens on nothing.
 */
function toolParametersSchema(tool: Tool): JsonSchema {
  const { $schema, ...schema } = z.toJSONSchema(tool.parameters, { io: 'input' });
  return schema as JsonSchema;
}

/** The exact capability prose used by direct provider tools and routed discovery. */
function toolDescription(tool: Tool): string {
  return tool.output?.artifacts === true
    ? `${tool.description}\n\n${ARTIFACT_OUTPUT_NOTICE}`
    : tool.description;
}

function renderTool(tool: Tool): string {
  const schema = toolParametersSchema(tool);

  const lines = [
    `Tool: ${tool.name}`,
    `Description: ${toolDescription(tool)}`,
    `\nArguments: ${JSON.stringify(placeholders(schema), null, 2)}`,
  ];

  const docs = paramDocs(schema);
  if (docs.length > 0) {
    lines.push('\nParameters:', ...docs);
  }

  return lines.join('\n');
}

export { ARTIFACT_OUTPUT_NOTICE, renderTool, toolDescription, toolParametersSchema };

export type { JsonSchema };
