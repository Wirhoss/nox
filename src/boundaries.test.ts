import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';

const SRC = import.meta.dir;
const EXTENSION_API = resolve(SRC, '..', 'packages', 'extension-api', 'src');
const BUILTIN = 'extensions/builtin/';
const UI = 'ui/';

const COMPOSITION_ROOT = 'bootstrap.ts';

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

/** `extensions/builtin/providers/openai/x.ts` → `extensions/builtin/providers/openai`. */
function builtinPackage(path: string): string | undefined {
  if (!path.startsWith(BUILTIN)) return undefined;
  const [point, name] = path.slice(BUILTIN.length).split('/');
  return point === undefined || name === undefined ? undefined : `${BUILTIN}${point}/${name}`;
}

describe('Extension API package', () => {
  test('is autonomous and never imports a kernel source file', () => {
    const violations: string[] = [];

    for (const relativeFile of [...new Glob('**/*.ts').scanSync(EXTENSION_API)].map(posix)) {
      const file = join(EXTENSION_API, relativeFile);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(EXTENSION_API)) {
          violations.push(`${relativeFile} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('kernel boundaries', () => {
  test('does not re-export the Extension API through compatibility modules', () => {
    const violations = sourceFiles().filter((file) => {
      const source = readFileSync(join(SRC, file), 'utf8');
      return /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+'@nox\/extension-api'/u.test(source);
    });

    expect(violations).toEqual([]);
  });

  test('the UI and kernel communicate only through the HTTP surface', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      for (const target of localImports(file)) {
        const crossesIntoUi = !file.startsWith(UI) && target.startsWith(UI);
        const crossesIntoKernel = file.startsWith(UI) && !target.startsWith(UI);

        if (crossesIntoUi || crossesIntoKernel) {
          violations.push(`${file} imports ${target}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

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

    // Builtins are discovered packages. Even the composition root must not name
    // one, or installed packages could never travel through the same path.
    expect(violations).toEqual([]);
  });

  test('production packages depend only on their own files and the public API', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      const owner = builtinPackage(file);
      if (owner === undefined || file.endsWith('.test.ts')) continue;

      for (const target of localImports(file)) {
        if (!target.startsWith(`${owner}/`)) violations.push(`${file} imports ${target}`);
      }
    }

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
    expect(files).toContain(COMPOSITION_ROOT);
    expect(files.some((file) => file.startsWith(BUILTIN))).toBe(true);
  });

  test('no kernel file, including the composition root, names one', () => {
    const importers = sourceFiles().filter(
      (file) =>
        !file.startsWith(BUILTIN) && localImports(file).some((path) => path.startsWith(BUILTIN)),
    );

    expect(importers).toEqual([]);
  });
});
