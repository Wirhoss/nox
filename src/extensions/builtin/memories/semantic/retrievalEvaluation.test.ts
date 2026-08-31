import { describe, expect, test } from 'bun:test';

import { MemoryExtensionStorageProvider } from '../../../storage';
import {
  CASE_KINDS,
  DECAY_CASES,
  DECAY_EVALUATION_AT,
  DECAY_FACTS,
  evaluateRetrieval,
  recallAt,
  reciprocalRank,
  RETRIEVAL_CASES,
  RETRIEVAL_FACTS,
  TOP_K,
} from './retrievalEvaluation';
import { SemanticStore } from './store';

import type { EmbeddingModel } from '@nox/extension-api';

const DIMENSIONS = 16;
const SCOPE = { agentId: 'agent-a', issuer: 'web', subject: 'ana' };
const AGING_FACTS = [
  {
    createdAt: '2023-01-01T00:00:00.000Z',
    kind: 'state',
    text: 'Ana on-call rotation comes round every fourth week.',
  },
  {
    createdAt: '2026-08-20T00:00:00.000Z',
    kind: 'preference',
    text: 'Ana refuses meetings before 10:00 because she writes in the morning.',
  },
  {
    createdAt: '2026-08-20T00:00:00.000Z',
    kind: 'preference',
    text: 'Ana schedules her deep work between 07:00 and 10:00.',
  },
] as const;
const AGING_CASES = [
  {
    expected: [1],
    kind: 'paraphrase',
    name: 'current beats stale',
    query: 'can we schedule an early stand-up with her',
    why: 'A deterministic near-tie verifies the time-dependent rank rather than language quality.',
  },
  {
    expected: [0],
    kind: 'literal',
    name: 'old remains answerable',
    query: 'on-call rotation',
    why: 'A deterministic direct match verifies that bounded decay does not erase an old fact.',
  },
] as const;

/**
 * A word-hash embedder.
 *
 * Not a good one, and not meant to be: it stands in for a real model so the
 * harness itself can be tested deterministically. What it cannot do is judge
 * paraphrase, which is exactly why the corpus is scored against a real model by
 * the eval script rather than here.
 */
function hashingEmbedder(): EmbeddingModel {
  return {
    config: () => ({ dimensions: DIMENSIONS, kind: 'embedding', modelId: 'hash' }),
    embed: (texts) =>
      Promise.resolve({
        dimensions: DIMENSIONS,
        modelId: 'hash',
        vectors: texts.map((text) => hash(text)),
      }),
    reference: { model: 'hash', provider: 'test' },
  };
}

function agingEmbedder(): EmbeddingModel {
  return {
    config: () => ({ dimensions: DIMENSIONS, kind: 'embedding', modelId: 'aging' }),
    embed: (texts) =>
      Promise.resolve({
        dimensions: DIMENSIONS,
        modelId: 'aging',
        vectors: texts.map((text) => {
          const angle = text.includes('early stand-up')
            ? 0.047
            : text.includes('refuses meetings')
              ? 0.1
              : text.includes('deep work')
                ? 0.2
                : 0;
          return Array.from({ length: DIMENSIONS }, (_, index) =>
            index === 0 ? Math.cos(angle) : index === 1 ? Math.sin(angle) : 0,
          );
        }),
      }),
    reference: { model: 'aging', provider: 'test' },
  };
}

function hash(text: string): number[] {
  const buckets = Array.from({ length: DIMENSIONS }, () => 0);
  for (const word of text.toLowerCase().split(/\W+/u).filter(Boolean)) {
    let code = 0;
    for (const character of word) code = (code * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
    const bucket = code % DIMENSIONS;
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  const length = Math.hypot(...buckets);
  return length === 0 ? buckets : buckets.map((value) => value / length);
}

async function store(): Promise<SemanticStore> {
  const storage = await new MemoryExtensionStorageProvider().forExtension({
    extensionId: 'nox.memory.semantic',
    migrations: `${import.meta.dir}/migrations`,
  });
  const created = new SemanticStore(storage);
  await created.openVectors({ dimensions: DIMENSIONS, model: 'hash', provider: 'test' });
  return created;
}

describe('the retrieval corpus', () => {
  test('is balanced across what a query can be, not weighted toward one arm', () => {
    const counts = new Map<string, number>();
    for (const entry of RETRIEVAL_CASES) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }

    // The first version of this corpus was six-eighths paraphrase, which proves
    // vectors are worth having and cannot be used to decide anything else. Every
    // kind carries real weight now, so an arm is scored where it should win and
    // where it should lose.
    for (const kind of CASE_KINDS) {
      const share = (counts.get(kind) ?? 0) / RETRIEVAL_CASES.length;
      expect(share).toBeGreaterThanOrEqual(0.15);
      expect(share).toBeLessThanOrEqual(0.4);
    }
  });

  test('is large enough for recall@5 to mean something', () => {
    // With ten facts a random ranker scores 50% at recall@5, so anything
    // measured against a corpus that size describes the corpus, not the ranking.
    expect(RETRIEVAL_FACTS.length).toBeGreaterThanOrEqual(30);
    expect(RETRIEVAL_FACTS.length / TOP_K).toBeGreaterThanOrEqual(6);
  });

  test('asks some questions nothing in it answers', () => {
    const unanswerable = RETRIEVAL_CASES.filter((entry) => entry.kind === 'unanswerable');

    // Without these the report cannot see what a memory returns when it has
    // nothing to say, which is a token budget spent on noise every time.
    expect(unanswerable.length).toBeGreaterThanOrEqual(3);
    for (const entry of unanswerable) expect(entry.expected).toEqual([]);
  });

  test('points every answerable case at a fact that exists, and says why', () => {
    for (const entry of RETRIEVAL_CASES) {
      for (const index of entry.expected) expect(RETRIEVAL_FACTS[index]).toBeDefined();
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  test('holds near-misses rather than unrelated statements', () => {
    const hours = RETRIEVAL_FACTS.filter((fact) => /10:00|morning|deep work/u.test(fact.text));
    const databases = RETRIEVAL_FACTS.filter((fact) => /Postgres|Mongo|database/u.test(fact.text));

    // With one plausible answer per query even a broken ranker scores well.
    expect(hours.length).toBeGreaterThanOrEqual(2);
    expect(databases.length).toBeGreaterThanOrEqual(3);
  });

  test('changes only time in the real-model decay ablation', () => {
    expect(DECAY_FACTS).toHaveLength(RETRIEVAL_FACTS.length);
    expect(DECAY_FACTS.map((fact) => fact.text)).toEqual(RETRIEVAL_FACTS.map((fact) => fact.text));
    for (const entry of DECAY_CASES) {
      for (const index of entry.expected) expect(DECAY_FACTS[index]).toBeDefined();
    }
  });
});

describe('reciprocalRank', () => {
  test('rewards the position of the first expected hit', () => {
    expect(reciprocalRank([7, 3, 9], [3])).toBe(0.5);
    expect(reciprocalRank([3, 7, 9], [3])).toBe(1);
    expect(reciprocalRank([7, 8], [3])).toBe(0);
  });
});

describe('recallAt', () => {
  test('counts only what reached the cut', () => {
    expect(recallAt([1, 2, 3, 4, 5, 6], [1, 6], 5)).toBe(0.5);
    expect(recallAt([1, 2, 3, 4, 5, 6], [1, 2], 5)).toBe(1);
  });
});

describe('evaluateRetrieval', () => {
  test('scores the path a conversation actually takes', async () => {
    const report = await evaluateRetrieval(await store(), hashingEmbedder(), SCOPE);

    expect(report.total).toBe(RETRIEVAL_CASES.length);
    expect(report.score.recall).toBeGreaterThanOrEqual(0);
    expect(report.score.recall).toBeLessThanOrEqual(1);
    expect(report.byKind.map((kind) => kind.kind)).toEqual([...CASE_KINDS]);
  });

  test('scores recall over answerable cases only', async () => {
    const report = await evaluateRetrieval(await store(), hashingEmbedder(), SCOPE);
    const unanswerable = report.byKind.find((kind) => kind.kind === 'unanswerable');

    // Averaging a free 1.0 for every query with nothing to miss would let the
    // overall number rise with the count of questions nobody can answer.
    expect(unanswerable?.score.recall).toBe(0);
    expect(unanswerable?.score.noise).toBeGreaterThan(0);
  });

  test('counts what comes back when nothing should', async () => {
    const report = await evaluateRetrieval(await store(), hashingEmbedder(), SCOPE);

    // Retrieval has no relevance floor: it returns its best guesses whether or
    // not any of them are about the question. Every unanswerable case therefore
    // fails, on purpose, so the gap cannot be forgotten.
    for (const result of report.cases) {
      if (result.case.kind !== 'unanswerable') continue;
      expect(result.passed).toBeFalse();
      expect(result.score.noise).toBeGreaterThan(0);
    }
  });

  test('trades recall for quiet as the floor tightens', async () => {
    const open = await evaluateRetrieval(await store(), hashingEmbedder(), SCOPE, {
      maxDistance: 2,
    });
    const tight = await evaluateRetrieval(await store(), hashingEmbedder(), SCOPE, {
      maxDistance: 0.2,
    });

    // Both directions of the trade, so a floor can never be tightened without
    // the cost showing up: a strict one returns less of everything, including
    // the answers. Where to sit on that curve is measured against a real model
    // by the eval script; what is asserted here is that the curve exists.
    const quiet = (report: typeof open): number =>
      report.byKind.find((kind) => kind.kind === 'unanswerable')?.score.noise ?? 0;
    expect(quiet(tight)).toBeLessThan(quiet(open));
    expect(tight.score.recall).toBeLessThan(open.score.recall);
  });

  test('improves a temporal near-tie without erasing the old direct answer', async () => {
    const created = await store();
    const baseline = await evaluateRetrieval(created, agingEmbedder(), SCOPE, {
      cases: AGING_CASES,
      facts: AGING_FACTS,
      maxDistance: 2,
    });
    const decayed = await evaluateRetrieval(
      created,
      agingEmbedder(),
      { ...SCOPE, subject: 'ana-decayed' },
      {
        at: DECAY_EVALUATION_AT,
        cases: AGING_CASES,
        facts: AGING_FACTS,
        maxDistance: 2,
      },
    );

    expect(baseline.score).toMatchObject({ mrr: 0.75, recall: 1 });
    expect(decayed.score).toMatchObject({ mrr: 1, recall: 1 });
  });

  test('a recent access resets age instead of becoming a permanent rank bonus', async () => {
    const accessed = AGING_FACTS.map((fact, index) =>
      index === 0 ? { ...fact, lastAccessedAt: '2026-08-28T16:00:00.000Z' } : fact,
    );
    const report = await evaluateRetrieval(await store(), agingEmbedder(), SCOPE, {
      at: DECAY_EVALUATION_AT,
      cases: AGING_CASES,
      facts: accessed,
      maxDistance: 2,
    });

    expect(report.score).toMatchObject({ mrr: 0.75, recall: 1 });
  });

  test('keeps the evaluation inside its own scope', async () => {
    const created = await store();
    await evaluateRetrieval(created, hashingEmbedder(), SCOPE);

    const elsewhere = await created.factsByIds(
      { agentId: 'agent-a', issuer: 'web', subject: 'someone-else' },
      [1, 2, 3],
    );
    expect(elsewhere).toEqual([]);
  });
});
