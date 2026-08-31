import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { EXTENSION_EXTERNAL_PACKAGES } from '@nox/extension-api';

const root = resolve(import.meta.dir, '..');
const sourceRoot = join(root, 'src', 'extensions', 'builtin');
const outputRoot = join(root, 'dist', 'extensions', 'builtin');
const apiPackageRoot = join(root, 'packages', 'extension-api');
const apiOutput = join(root, 'dist', 'node_modules', '@nox', 'extension-api');
const manifestName = 'nox-extension.json';

interface BuildManifest {
  readonly id: string;
  readonly main: string;
  readonly migrations?: string;
  readonly workers?: readonly string[];
  readonly [key: string]: unknown;
}

async function manifests(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === manifestName)) {
    return [join(directory, manifestName)];
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      found.push(...(await manifests(join(directory, entry.name))));
    }
  }
  return found;
}

function assertBuild(result: Bun.BuildOutput, subject: string): void {
  if (result.success) return;
  for (const log of result.logs) process.stderr.write(`${log.message}\n`);
  throw new Error(`Could not build ${subject}.`);
}

await Promise.all([
  rm(outputRoot, { force: true, recursive: true }),
  rm(apiOutput, { force: true, recursive: true }),
]);

const apiBuild = Bun.spawn({
  cmd: [process.execPath, 'x', 'tsc', '-p', join(apiPackageRoot, 'tsconfig.build.json')],
  cwd: root,
  stderr: 'inherit',
  stdout: 'inherit',
});
if ((await apiBuild.exited) !== 0) throw new Error('Could not build @nox/extension-api.');
await mkdir(apiOutput, { recursive: true });
await cp(join(apiPackageRoot, 'dist'), join(apiOutput, 'dist'), { recursive: true });
await Promise.all([
  cp(join(apiPackageRoot, 'package.json'), join(apiOutput, 'package.json')),
  cp(join(apiPackageRoot, 'README.md'), join(apiOutput, 'README.md')),
]);

for (const manifestPath of await manifests(sourceRoot)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest;
  if (typeof manifest.id !== 'string' || typeof manifest.main !== 'string') {
    throw new TypeError(`${manifestPath} has no extension id or entry point.`);
  }

  const destination = join(outputRoot, manifest.id);
  const result = await Bun.build({
    entrypoints: [resolve(dirname(manifestPath), manifest.main)],
    external: [...EXTENSION_EXTERNAL_PACKAGES],
    minify: true,
    naming: 'extension.js',
    outdir: destination,
    target: 'bun',
  });
  assertBuild(result, manifest.id);

  // Built separately because nothing imports them: a worker is resolved from a
  // URL at runtime, so the entry point's dependency graph never reaches it and a
  // build that only followed imports would ship a package missing half of
  // itself. Its relative path and base name are kept, so the URL it is started
  // from still resolves without a package-specific rewrite.
  const workers = manifest.workers ?? [];
  if (workers.length > 0) {
    const built = await Bun.build({
      entrypoints: workers.map((worker) => resolve(dirname(manifestPath), worker)),
      external: [...EXTENSION_EXTERNAL_PACKAGES],
      minify: true,
      naming: '[dir]/[name].js',
      outdir: destination,
      root: dirname(manifestPath),
      target: 'bun',
    });
    assertBuild(built, `${manifest.id} workers`);
  }

  // Copied rather than built: they are SQL the host reads at activation, not
  // modules anything imports, so a bundle that only followed imports would ship
  // a package whose schema never arrives. The declared path is kept as it is,
  // because the manifest that names it travels unchanged.
  if (manifest.migrations !== undefined) {
    await cp(
      resolve(dirname(manifestPath), manifest.migrations),
      join(destination, manifest.migrations),
      { recursive: true },
    );
  }

  await writeFile(
    join(destination, manifestName),
    `${JSON.stringify(
      {
        ...manifest,
        main: 'extension.js',
        ...(workers.length === 0
          ? {}
          : {
              workers: workers.map((worker) => `${worker.replace(/[.][^./\\]+$/u, '')}.js`),
            }),
      },
      undefined,
      2,
    )}\n`,
  );
}
