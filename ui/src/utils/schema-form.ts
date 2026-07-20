/*
 * Reading and writing config objects described by a runtime field schema.
 *
 * Tool services declare their settings as a list of `SettingsField`, where
 * `name` is a dot path (`retry.attempts`) into an otherwise opaque config
 * object. The UI never knows a service's shape ahead of time, so these three
 * helpers are what let a form be rendered from the schema alone.
 */

import type { SettingsField } from './types';

/** Reads a dot path, yielding undefined rather than throwing on a gap. */
function getNested(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (current, part) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined),
    value,
  );
}

/** Writes a dot path, creating the intermediate objects it needs. */
function setNested(value: Record<string, unknown>, path: string, next: unknown): void {
  const parts = path.split('.');
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = next;
}

/**
 * Builds the starting config for a set of fields.
 *
 * A declared default always wins. A required field without one is seeded with
 * an empty value so the control renders as touched-but-blank rather than
 * undefined, which would make it uncontrolled. Secrets are skipped: seeding
 * one with an empty string would read as an instruction to clear the stored
 * credential.
 */
function defaultsFor(fields: SettingsField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      setNested(result, field.name, field.defaultValue);
    } else if (field.required && !field.secret) {
      setNested(result, field.name, field.type === 'number' ? field.minimum ?? 1 : '');
    }
  }
  return result;
}

export {
  defaultsFor,
  getNested,
  setNested,
};
