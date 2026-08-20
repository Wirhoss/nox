import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';

const SRC = import.meta.dir;
const BUILTIN = 'extensions/builtin/';

function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

function sourceFiles(): string[] {
  return [...new Glob('**/*.ts').scanSync(SRC)].map(posix).sort();
}

/** Every relative specifier in a file, resolved to a path under `src/`. */
function localImports(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8');

  return [...source.matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => posix(relative(SRC, resolve(SRC, dirname(file), specifier))));
}

/** `extensions/builtin/openai/x.ts` → `extensions/builtin/openai`. */
function builtinPackage(path: string): string | undefined {
  if (!path.startsWith(BUILTIN)) return undefined;
  const name = path.slice(BUILTIN.length).split('/')[0];
  return name === undefined ? undefined : `${BUILTIN}${name}`;
}

describe('builtin extensions', () => {
  test('are imported by nothing else in the tree', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      if (file.startsWith(BUILTIN)) continue;

      for (const target of localImports(file)) {
        if (target.startsWith(BUILTIN)) {
          violations.push(`${file} imports ${target}`);
        }
      }
    }

    // A builtin is reachable only from whatever composes the application and
    // registers it. Anything else importing one is the kernel reaching for a
    // concrete capability, which is what contribution points exist to prevent.
    expect(violations).toEqual([]);
  });

  test('do not import each other', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      const owner = builtinPackage(file);
      if (owner === undefined) continue;

      for (const target of localImports(file)) {
        const targetPackage = builtinPackage(target);
        if (targetPackage !== undefined && targetPackage !== owner) {
          violations.push(`${file} imports ${target}`);
        }
      }
    }

    // Each builtin is a package in everything but its publication. One reaching
    // into another is the dependency graph that `host.ts` exists to resolve,
    // arriving early and without the machinery to handle it.
    expect(violations).toEqual([]);
  });

  test('the scan actually sees this repository', () => {
    const files = sourceFiles();

    expect(files).toContain('application.ts');
    expect(files.some((file) => file.startsWith(BUILTIN))).toBe(true);
  });
});
