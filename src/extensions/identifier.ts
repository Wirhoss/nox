import { z } from 'zod';

/** Package-like: lowercase, optionally scoped. Fixed here so the deferred
 *  manifest schema can reuse it without the contract depending on manifests. */
const IDENTIFIER_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(IDENTIFIER_PATTERN, 'Use a lowercase package-like identifier.');

/**
 * Throws `TypeError`: an invalid identifier is a mistake at the declaration
 * site, not a runtime condition a caller can recover from.
 */
function assertIdentifier(value: string, kind: string): void {
  const result = identifierSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`Invalid ${kind} "${value}": ${result.error.issues[0]?.message ?? ''}`);
  }
}

export { assertIdentifier, identifierSchema };
