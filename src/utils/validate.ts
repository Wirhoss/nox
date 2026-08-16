import type { z } from 'zod';

function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');

  throw new RangeError(issues);
}

export { parseOrThrow };
