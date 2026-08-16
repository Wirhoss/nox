import type { z } from "zod";

/**
 * Parses with a schema and reports failure as a single-line RangeError.
 *
 * A raw `ZodError.message` is a multi-line JSON dump of every issue. These are
 * configuration mistakes made by the caller, so the message has to read like a
 * sentence, not like a payload.
 */
function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

  throw new RangeError(issues);
}

export { parseOrThrow };
