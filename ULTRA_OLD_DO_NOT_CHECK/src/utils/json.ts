function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PathDiff {
  added: string[];
  removed: string[];
}

function collectPaths(value: unknown, prefix: string, into: string[]): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, prefix ? `${prefix}.${key}` : key, into);
    }
    return;
  }
  into.push(prefix);
}

function diffPaths(source: unknown, parsed: unknown, prefix = ''): PathDiff {
  const diff: PathDiff = { added: [], removed: [] };

  if (isPlainObject(source) && isPlainObject(parsed)) {
    for (const [key, child] of Object.entries(parsed)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in source)) {
        collectPaths(child, path, diff.added);
        continue;
      }
      const nested = diffPaths(source[key], child, path);
      diff.added.push(...nested.added);
      diff.removed.push(...nested.removed);
    }
    for (const key of Object.keys(source)) {
      if (!(key in parsed)) {
        collectPaths(source[key], prefix ? `${prefix}.${key}` : key, diff.removed);
      }
    }
    return diff;
  }

  if (Array.isArray(source) && Array.isArray(parsed)) {
    for (let index = 0; index < Math.max(source.length, parsed.length); index += 1) {
      const path = `${prefix}[${index}]`;
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

export {
  diffPaths,
  isPlainObject,
  stableStringify,
};

export type {
  PathDiff,
};
