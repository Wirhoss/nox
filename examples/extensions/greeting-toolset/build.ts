import { resolve } from 'node:path';

import { EXTENSION_EXTERNAL_PACKAGES } from '@nox/extension-api';

/**
 * How an extension outside the Nox repository builds itself.
 *
 * The externals are not written out here on purpose. `@nox/extension-api`
 * declares which packages Nox resolves at runtime, so an extension asks the
 * contract instead of keeping its own copy that goes stale one Nox release
 * later. Everything else this package imports, it bundles.
 */
const root = import.meta.dir;

const result = await Bun.build({
  entrypoints: [resolve(root, 'src', 'extension.ts')],
  external: [...EXTENSION_EXTERNAL_PACKAGES],
  outdir: resolve(root, 'dist'),
  target: 'bun',
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log.message}\n`);
  throw new Error('Could not build the greeting tool set.');
}
