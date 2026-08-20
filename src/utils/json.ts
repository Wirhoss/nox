interface PathDiff {
  added: string[];
  removed: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(',')}}`;
}

function collectPaths(value: unknown, prefix: string, into: string[]): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, prefix.length > 0 ? `${prefix}.${key}` : key, into);
    }
    return;
  }
  into.push(prefix);
}

function diffPaths(source: unknown, parsed: unknown, prefix = ''): PathDiff {
  const diff: PathDiff = { added: [], removed: [] };

  if (isPlainObject(source) && isPlainObject(parsed)) {
    for (const [key, child] of Object.entries(parsed)) {
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (!Object.hasOwn(source, key)) {
        collectPaths(child, path, diff.added);
        continue;
      }
      const nested = diffPaths(source[key], child, path);
      diff.added.push(...nested.added);
      diff.removed.push(...nested.removed);
    }

    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(parsed, key)) {
        collectPaths(source[key], prefix.length > 0 ? `${prefix}.${key}` : key, diff.removed);
      }
    }

    return diff;
  }

  if (Array.isArray(source) && Array.isArray(parsed)) {
    for (let index = 0; index < Math.max(source.length, parsed.length); index += 1) {
      const path = `${prefix}[${String(index)}]`;
      if (index >= source.length) {
        collectPaths(parsed[index], path, diff.added);
      } else if (index >= parsed.length) {
        collectPaths(source[index], path, diff.removed);
      } else {
        const nested = diffPaths(source[index], parsed[index], path);
        diff.added.push(...nested.added);
        diff.removed.push(...nested.removed);
      }
    }
  }

  return diff;
}

export { diffPaths, isPlainObject, stableStringify };

export type { PathDiff };
