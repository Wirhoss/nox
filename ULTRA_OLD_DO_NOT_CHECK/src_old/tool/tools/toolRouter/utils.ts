import { z } from 'zod';

import type { MessageContentText } from '../../../provider';
import type { Tool } from '../../tool';

function asTextToolResponse(result: unknown): MessageContentText[] {
  return [{ type: 'text', text: JSON.stringify(result) }];
}

type JsonSchema = {
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  type?: string | string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
};

const MAX_DEPTH = 3;

const unique = (xs: string[]): string[] => [...new Set(xs)];

function typeName(schema: JsonSchema): string {
  if (!schema || typeof schema !== 'object') return 'unknown';

  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');

  const union = schema.anyOf ?? schema.oneOf;
  if (union) return unique(union.map(typeName)).join(' | ');

  if (Array.isArray(schema.type)) {
    return unique(schema.type.map((t) => typeName({ ...schema, type: t }))).join(' | ');
  }

  if (schema.type === 'array') {
    const inner = typeName(schema.items ?? {});
    return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
  }

  return typeof schema.type === 'string' ? schema.type : 'unknown';
}

function placeholders(schema: JsonSchema, depth = 0): unknown {
  if (schema.properties && depth < MAX_DEPTH) {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, prop]) => [
        key,
        placeholders(prop, depth + 1),
      ]),
    );
  }
  if (schema.type === 'array' && schema.items && depth < MAX_DEPTH) {
    return [placeholders(schema.items, depth + 1)];
  }
  return `<${typeName(schema)}>`;
}

function paramDocs(schema: JsonSchema, prefix = ''): string[] {
  const lines: string[] = [];
 
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
 
    if (prop.description) {
      const def =
        prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : '';
      lines.push(`- ${path}: ${prop.description}${def}`);
    }
 
    const union = prop.anyOf ?? prop.oneOf;
    const inner = union?.find((v) => v.properties || v.items) ?? prop;
 
    if (inner.properties) lines.push(...paramDocs(inner, path));
    if (inner.items?.properties) lines.push(...paramDocs(inner.items, `${path}[]`));
  }
 
  return lines;
}

function renderTool(tool: Tool): string {
  const schema = z.toJSONSchema(tool.parameters, { io: 'input' }) as JsonSchema;
 
  const lines = [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    `\nArguments: ${JSON.stringify(placeholders(schema), null, 2)}`, 
  ];
 
  const docs = paramDocs(schema);
  if (docs.length > 0) {
    lines.push('\nParameters:', ...docs);
  }

  return lines.join('\n');
}

export {
  asTextToolResponse,
  renderTool,
};