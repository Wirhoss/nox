const MAX_EVALUATION_CHARACTERS = 100_000;

/**
 * Makes arbitrary page results safe for the tool's JSON report.
 *
 * Normalizing here keeps unusual page values from failing later in
 * stableStringify and bounds a page that tries to return an enormous value into
 * the transcript.
 */
function evaluationResult(value: unknown): unknown {
  if (value === undefined) return null;

  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key: string, entry: unknown): unknown => {
      if (typeof entry === 'bigint') return `${String(entry)}n`;
      if (typeof entry === 'function') {
        return `[Function ${entry.name.length > 0 ? entry.name : 'anonymous'}]`;
      }
      if (typeof entry === 'symbol') return String(entry);
      if (typeof entry === 'object' && entry !== null) {
        if (seen.has(entry)) return '[Circular]';
        seen.add(entry);
      }
      return entry;
    });
  } catch {
    return { preview: printable(value), serializationFailed: true };
  }

  if (serialized.length > MAX_EVALUATION_CHARACTERS) {
    return {
      preview: serialized.slice(0, MAX_EVALUATION_CHARACTERS),
      truncated: true,
    };
  }
  return JSON.parse(serialized) as unknown;
}

function printable(value: unknown): string {
  try {
    return String(value).slice(0, 1_000);
  } catch {
    return '[Unprintable result]';
  }
}

export { evaluationResult };
