/**
 * The subset of JSON Schema this codebase produces and reads back.
 *
 * It exists because a zod schema is not something that crosses a boundary: a
 * model is handed one of these to decide what to call, and a transport is handed
 * one to draw a form or register a slash command. Both are looking at the same
 * conversion of the same declaration, which is the point — a parameter list
 * described twice is a parameter list that drifts.
 */
interface JsonSchema {
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

export type { JsonSchema };
