/**
 * Scores the memory's vector retrieval against a real embedding model — a
 * stand-in embedder cannot judge paraphrase, and paraphrase is most of what a
 * memory is asked for. Scores are broken out by kind of query, because an
 * average carried by literal lookups hides where retrieval is weak.
 *
 * Weights download on first use and land in the cache directory below.
 *
 *   NOX_EVAL_EMBED_MODEL=Xenova/all-MiniLM-L6-v2 \
 *   NOX_EVAL_EMBED_DIMENSIONS=384 \
 *   bun run scripts/eval-retrieval.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { calibrateFloor } from '../src/extensions/builtin/memories/semantic/calibration';
import { NO_FLOOR } from '../src/extensions/builtin/memories/semantic/config';
import {
  DECAY_CASES,
  DECAY_EVALUATION_AT,
  DECAY_FACTS,
  evaluateRetrieval,
  TOP_K,
} from '../src/extensions/builtin/memories/semantic/retrievalEvaluation';
import { SemanticStore } from '../src/extensions/builtin/memories/semantic/store';
import { LocalProvider } from '../src/extensions/builtin/providers/local/localProvider';
import { DatabaseExtensionStorageProvider } from '../src/extensions/storage';

import type { EmbeddingModel } from '@nox/extension-api';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Set ${name} to run the retrieval evaluation.`);
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

const embedding: EmbeddingModel = {
  config: () => ({ dimensions, kind: 'embedding', modelId }),
  embed: (texts, signal) =>
    provider.embed({ modelId, ...(signal === undefined ? {} : { signal }), texts }),
  reference: { model: modelId, provider: 'local' },
};

// A throwaway database: the corpus is seeded fresh so a rerun measures the
// ranking, never what a previous run left behind.
const directory = mkdtempSync(join(tmpdir(), 'nox-retrieval-eval-'));
const storageProvider = new DatabaseExtensionStorageProvider({
  path: join(directory, 'extensions.db'),
});
const storage = await storageProvider.forExtension({
  extensionId: 'nox.memory.semantic',
  migrations: join(
    import.meta.dir,
    '..',
    'src',
    'extensions',
    'builtin',
    'memories',
    'semantic',
    'migrations',
  ),
});
const store = new SemanticStore(storage);
await store.openVectors({ dimensions, model: modelId, provider: 'local' });

const scope = { agentId: 'eval', issuer: 'eval', subject: 'ana' };
const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
const pad = (text: string, width: number): string => text.padEnd(width);
const line = (text: string): void => {
  process.stdout.write(text + '\n');
};

// The floor this model gets, measured the way an installation measures it —
// so the headline is what someone running this model actually sees, and the
// sweep below says whether the measurement landed where it should have.
const floor = await calibrateFloor(embedding);

const report = await evaluateRetrieval(store, embedding, scope, { maxDistance: floor });
line(`Relevance floor, measured for ${modelId}: ${floor.toFixed(3)}`);
line('');

for (const result of report.cases) {
  const measured =
    result.case.expected.length === 0
      ? `${String(result.score.noise)} facts returned`
      : `recall ${percent(result.score.recall)}  MRR ${result.score.mrr.toFixed(2)}`;
  const near = `  nearest ${Number.isFinite(result.score.nearest) ? result.score.nearest.toFixed(3) : 'n/a'}`;
  line(
    `${result.passed ? 'pass' : 'FAIL'}  ${pad(result.case.kind, 13)}` +
      `${pad(result.case.name, 34)}${pad(measured, 30)}${near}`,
  );
}

line('');
line(`${String(report.passed)}/${String(report.total)} cases`);
line('');
line(`${pad('', 14)}${pad('recall@5', 12)}MRR`);
for (const kind of report.byKind) {
  if (kind.total === 0 || kind.kind === 'unanswerable') continue;
  line(`${pad(kind.kind, 14)}${pad(percent(kind.score.recall), 12)}${kind.score.mrr.toFixed(2)}`);
}
line(`${pad('OVERALL', 14)}${pad(percent(report.score.recall), 12)}${report.score.mrr.toFixed(2)}`);

const unanswerable = report.byKind.find((kind) => kind.kind === 'unanswerable');
if (unanswerable !== undefined && unanswerable.total > 0) {
  line('');
  line(
    `With nothing to answer (${String(unanswerable.total)} queries), ` +
      `${unanswerable.score.noise.toFixed(1)} of ${String(TOP_K)} facts came back anyway. ` +
      'That is context budget spent on nothing.',
  );
  const answerable = report.byKind
    .filter((kind) => kind.kind !== 'unanswerable' && kind.total > 0)
    .map((kind) => kind.score.nearest);
  line(
    `  nearest neighbour, answerable: ${(
      answerable.reduce((sum, value) => sum + value, 0) / answerable.length
    ).toFixed(3)}   unanswerable: ${unanswerable.score.nearest.toFixed(3)}`,
  );
}

// A separate time-varying slice makes decay measurable without letting ages
// leak into the semantic benchmark or pretending a uniformly dated corpus can
// say anything about staleness.
const temporalOptions = {
  cases: DECAY_CASES,
  facts: DECAY_FACTS,
  maxDistance: floor,
} as const;
const withoutDecay = await evaluateRetrieval(
  store,
  embedding,
  { ...scope, subject: 'ana-decay-off' },
  temporalOptions,
);
const withDecay = await evaluateRetrieval(
  store,
  embedding,
  { ...scope, subject: 'ana-decay-on' },
  { ...temporalOptions, at: DECAY_EVALUATION_AT },
);
const decayImproved =
  withDecay.score.recall >= withoutDecay.score.recall &&
  withDecay.score.mrr > withoutDecay.score.mrr;
line('');
line('Temporal ranking, over an old unused near-match and current facts:');
line(`  ${pad('', 16)}${pad('recall@5', 12)}MRR`);
line(
  `  ${pad('without decay', 16)}${pad(percent(withoutDecay.score.recall), 12)}` +
    withoutDecay.score.mrr.toFixed(2),
);
line(
  `  ${pad('with decay', 16)}${pad(percent(withDecay.score.recall), 12)}` +
    `${withDecay.score.mrr.toFixed(2)}  ${decayImproved ? 'improved' : 'NO IMPROVEMENT'}`,
);

// The floor is swept rather than argued about. Every value costs recall and
// buys quiet; the table is what makes that trade visible instead of asserted.
line('');
line('Relevance floor, over the same stored corpus:');
line(
  `  ${pad('max distance', 15)}${pad('recall@5', 12)}${pad('MRR', 8)}facts returned when nothing answers`,
);
// The measured value is swept alongside the grid rather than trusted: if some
// other floor buys the same quiet at less recall, the calibration is wrong and
// this table is where that shows.
const sweep = [...new Set([NO_FLOOR, 1.4, 1.35, 1.3, 1.25, floor, 1.2, 1.15, 1.1, 1, 0.9])].sort(
  (left, right) => right - left,
);
for (const maxDistance of sweep) {
  const swept = await evaluateRetrieval(
    store,
    embedding,
    { ...scope, subject: `ana-d${String(maxDistance)}` },
    { maxDistance },
  );
  const quiet = swept.byKind.find((kind) => kind.kind === 'unanswerable');
  const mark = maxDistance === floor ? '  <- measured' : '';
  line(
    `  ${pad(maxDistance.toFixed(3), 15)}${pad(percent(swept.score.recall), 12)}` +
      `${pad(swept.score.mrr.toFixed(2), 8)}${pad((quiet?.score.noise ?? 0).toFixed(2), 8)}${mark}`,
  );
}

await provider.dispose();
await storageProvider.close();
process.exit(report.passed < report.total || !decayImproved ? 1 : 0);
