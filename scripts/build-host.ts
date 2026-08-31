import { resolve } from 'node:path';

import { HOST_PROVIDED_PACKAGES } from '@nox/extension-api';

/**
 * The kernel bundle.
 *
 * A script rather than a line of flags in the Dockerfile, because the flags
 * were a fourth handwritten copy of the host package list and had already
 * drifted from the other three. What the host leaves external and what an
 * extension leaves external now come from the same declaration; they differ
 * only where they genuinely differ, which is `@nox/extension-api` — the host
 * publishes it, so the host is the one bundle that inlines it.
 */
const root = resolve(import.meta.dir, '..');

const result = await Bun.build({
  entrypoints: [resolve(root, 'index.ts')],
  external: [...HOST_PROVIDED_PACKAGES],
  minify: { identifiers: false, syntax: true, whitespace: true },
  outdir: resolve(root, 'dist'),
  naming: 'nox.js',
  target: 'bun',
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log.message}\n`);
  throw new Error('Could not build the Nox kernel bundle.');
}
