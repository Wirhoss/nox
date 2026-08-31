/**
 * What relevance floor each calibration quantile would produce.
 *
 * The floor is estimated from unrelated probes alone, so the quantile is the
 * one knob deciding how strict it comes out — and nothing in the calibration
 * itself can say which value is right, because it never sees a pair that *is*
 * related. This prints the whole curve so the choice can be made against the
 * retrieval evaluation's recall numbers rather than by feel.
 *
 *   NOX_EVAL_EMBED_MODEL=dsaad68/LFM2.5-Embedding-350M-ONNX-int8 \
 *   NOX_EVAL_EMBED_DIMENSIONS=1024 \
 *   bun run scripts/sweep-quantile.ts
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  floorFromGroups,
  PROBE_GROUPS,
  PROBES,
} from '../src/extensions/builtin/memories/semantic/calibration';
import { LocalProvider } from '../src/extensions/builtin/providers/local/localProvider';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Set ${name} to sweep the calibration quantile.`);
  }
  return value;
}

const modelId = required('NOX_EVAL_EMBED_MODEL');
const dimensions = Number.parseInt(process.env.NOX_EVAL_EMBED_DIMENSIONS ?? '384', 10);
const cacheDirectory = process.env.NOX_EVAL_CACHE_DIR ?? join(tmpdir(), 'nox-eval-models');

const provider = new LocalProvider(
  {
    cacheDirectory,
    embedding: { dimensions, enabled: true, model: modelId, precision: 'fp32', threads: 1 },
    maxRetries: 0,
    maxRetryDelayMs: 0,
    retryDelayMs: 0,
    type: 'local',
  },
  { defaultCacheDirectory: cacheDirectory },
);

const embedded = await provider.embed({ modelId, texts: [...PROBES] });

let offset = 0;
const groups = PROBE_GROUPS.map((group) => {
  const slice = embedded.vectors.slice(offset, offset + group.length);
  offset += group.length;
  return slice;
});

process.stdout.write(`Model: ${modelId} (${String(dimensions)} dimensions)\n\n`);
process.stdout.write('  quantile   floor\n');
for (const fraction of [0.1, 0.25, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1]) {
  const floor = floorFromGroups(groups, fraction);
  process.stdout.write(`  ${fraction.toFixed(2)}       ${floor.toFixed(3)}\n`);
}

// Per group as well, because the maximum is what ships and one language's
// probes deciding it for both is exactly the failure the grouping exists for.
process.stdout.write('\n  per group, at each quantile\n');
for (const [index, group] of groups.entries()) {
  const floors = [0.25, 0.5, 0.75, 1]
    .map((fraction) => floorFromGroups([group], fraction).toFixed(3))
    .join('  ');
  process.stdout.write(`  group ${String(index)}: ${floors}\n`);
}
