import type { FactKind } from './evaluation';
import type { Scope, SemanticStore } from './store';
import type { EmbeddingModel } from '@nox/extension-api';

/** How far down a hit still counts, and how many facts one recall may place. */
const TOP_K = 5;

/** Two is the far end of the L2 scale for unit vectors: every neighbour passes. */
const NO_FLOOR = 2;

/**
 * What a query is asking of the index, so each arm can be scored where it is
 * supposed to be strong rather than only where it happens to be.
 *
 * `unanswerable` is the one that is easy to leave out and expensive to. Nothing
 * in the corpus answers those, so the only thing they measure is what comes
 * back anyway — and a memory that always returns its five best guesses spends
 * a real token budget on noise every time the conversation moved on.
 */
const CASE_KINDS = ['ambiguous', 'literal', 'paraphrase', 'unanswerable'] as const;
type CaseKind = (typeof CASE_KINDS)[number];

interface SeedFact {
  readonly accessCount?: number;
  readonly createdAt?: string;
  readonly kind: FactKind;
  readonly lastAccessedAt?: string;
  readonly repetitions?: number;
  readonly text: string;
}

interface RetrievalCase {
  /** Indices into the seeded corpus that must come back in the top K. */
  readonly expected: readonly number[];
  readonly kind: CaseKind;
  readonly name: string;
  readonly query: string;
  readonly why: string;
}

interface Score {
  /**
   * How far the nearest fact was, averaged.
   *
   * The number a relevance floor would be set from: if a query nothing answers
   * has a systematically more distant nearest neighbour than one that is
   * answered, then a threshold can tell them apart, and if it does not, no
   * threshold can and the noise has to be lived with.
   */
  readonly nearest: number;
  /** Mean reciprocal rank of the first expected fact, over answerable cases. */
  readonly mrr: number;
  /** How much an unanswerable query still brings back, in facts. */
  readonly noise: number;
  /** Fraction of expected facts present in the top K, over answerable cases. */
  readonly recall: number;
}

interface RetrievalCaseResult {
  readonly case: RetrievalCase;
  readonly passed: boolean;
  readonly score: Score;
}

interface KindScore {
  readonly kind: CaseKind;
  readonly score: Score;
  readonly total: number;
}

interface RetrievalReport {
  readonly byKind: readonly KindScore[];
  readonly cases: readonly RetrievalCaseResult[];
  readonly passed: number;
  readonly score: Score;
  readonly total: number;
}

/**
 * One person's remembered facts, at a size where the metrics mean something.
 *
 * Thirty rather than ten, because recall@5 over ten facts is half the corpus:
 * a ranker choosing at random scores 50% there, so anything measured against it
 * says more about the corpus than about the ranking. Deliberately full of
 * near-misses too — three facts about her working hours, three about how she
 * likes to be written to, three about databases — because a corpus where every
 * query has exactly one plausible answer flatters any ranker that can read.
 */
const RETRIEVAL_FACTS: readonly SeedFact[] = Object.freeze([
  { kind: 'preference', text: 'Ana prefers Postgres over MongoDB for anything transactional.' },
  { kind: 'decision', text: 'Ana settled on Postgres 17 for the billing service in March 2026.' },
  { kind: 'state', text: 'Ana is on parental leave until 2026-05-01.' },
  { kind: 'identity', text: 'Ana is the platform lead and her team sits in Berlin.' },
  {
    kind: 'preference',
    text: 'Ana refuses meetings before 10:00 because she writes in the morning.',
  },
  { kind: 'preference', text: 'Ana wants code review comments phrased as questions, not orders.' },
  { kind: 'state', text: 'Ana broke her wrist skiing and is typing one-handed.' },
  { kind: 'decision', text: 'Ana dropped the Kafka migration and kept the outbox table instead.' },
  { kind: 'identity', text: 'Ana speaks Spanish at home and English at work.' },
  { kind: 'preference', text: 'Ana likes jasmine tea and never drinks coffee.' },
  { kind: 'identity', text: 'Ana partner Ivan runs the design team at a different company.' },
  { kind: 'preference', text: 'Ana keeps her notes in plain Markdown files, not in Notion.' },
  { kind: 'decision', text: 'Ana deploys on Fridays only when the change is a revert.' },
  { kind: 'state', text: 'Ana daughter was born in February 2026.' },
  { kind: 'state', text: 'Ana runs her own Nox instance on a Hetzner box in Falkenstein.' },
  {
    kind: 'preference',
    repetitions: 5,
    text: 'Ana finds pair programming exhausting and prefers async review.',
  },
  { kind: 'identity', text: 'Ana studied physics before moving into software.' },
  {
    kind: 'identity',
    text: 'Ana maintains an open-source SQLite extension for geospatial queries.',
  },
  { kind: 'preference', text: 'Ana uses Neovim with a config she has kept since 2019.' },
  { kind: 'preference', text: 'Ana dislikes being called Anita by colleagues.' },
  { kind: 'identity', text: 'Ana team owns the payments and billing domains.' },
  { kind: 'decision', text: 'Ana turned down a move into management twice.' },
  { kind: 'preference', text: 'Ana schedules her deep work between 07:00 and 10:00.' },
  { kind: 'state', text: 'Ana laptop is a ThinkPad running Fedora.' },
  { kind: 'preference', text: 'Ana prefers Spanish-language documentation when it exists.' },
  { kind: 'preference', text: 'Ana cycles to the office when it is warmer than five degrees.' },
  { kind: 'decision', text: 'Ana keeps the staging database at one tenth of production size.' },
  { kind: 'identity', text: 'Ana wrote the incident postmortem template the company now uses.' },
  {
    kind: 'preference',
    repetitions: 5,
    text: 'Ana avoids Slack huddles and answers in threads instead.',
  },
  { kind: 'state', text: 'Ana on-call rotation comes round every fourth week.' },
  // Identifiers: an error code, a path, an invented codename. These were added
  // to decide whether a text index was worth keeping beside the vectors, on the
  // theory that a small embedding model cannot place a token it has never seen.
  // It could, at rank one, and the text arm was removed. They stay because they
  // are the cases most likely to break under a different embedding model, which
  // makes them the ones worth rerunning when one is swapped in.
  {
    kind: 'decision',
    text: 'Ana traced the Friday outage to error ORA-01555 on the reporting replica.',
  },
  { kind: 'state', text: 'Ana keeps the production deploy key at infra/prod/deploy_key_v3.' },
  { kind: 'decision', text: 'Ana codenamed the storage migration Perihelion.' },
]);

/**
 * The cases, balanced across what a query can be.
 *
 * The first version of this corpus was six-eighths paraphrase, which is the
 * shape that proves vectors are worth having and the shape that cannot be used
 * to decide anything else — and something was decided on it, wrongly, until it
 * was balanced. A mix is what makes a later comparison mean what it appears to:
 * swapping the embedding model changes retrieval everywhere, and an average
 * carried by literal lookups would hide a collapse in paraphrase.
 */
const RETRIEVAL_CASES: readonly RetrievalCase[] = Object.freeze([
  {
    expected: [9],
    kind: 'literal',
    name: 'jasmine tea',
    query: 'jasmine tea',
    why: 'The easiest thing to retrieve; a failure here means something is badly wrong.',
  },
  {
    expected: [1],
    kind: 'literal',
    name: 'Postgres for billing',
    query: 'Postgres billing service',
    why: 'Three facts mention databases, so the words have to pick out the right one.',
  },
  {
    expected: [18],
    kind: 'literal',
    name: 'Neovim config',
    query: 'Neovim config',
    why: 'A rare term appearing in exactly one fact, and nowhere else to confuse it with.',
  },
  {
    expected: [14],
    kind: 'literal',
    name: 'Hetzner box',
    query: 'Hetzner Falkenstein',
    why: 'Proper nouns are what a vector model is classically worst at.',
  },
  {
    expected: [29],
    kind: 'literal',
    name: 'on-call rotation',
    query: 'on-call rotation',
    why: 'Literal, and competes with nothing; a failure here is a broken index.',
  },
  {
    expected: [27],
    kind: 'literal',
    name: 'postmortem template',
    query: 'incident postmortem template',
    why: 'Literal over a longer phrase, where a single term would match nothing.',
  },
  {
    expected: [30],
    kind: 'literal',
    name: 'error code',
    query: 'ORA-01555',
    why: 'An error code has no useful vector; a text index treats it as the rarest term there is.',
  },
  {
    expected: [31],
    kind: 'literal',
    name: 'config path',
    query: 'infra/prod/deploy_key_v3',
    why: 'A path tokenizes into fragments, which is where an embedding model is most at risk.',
  },
  {
    expected: [32],
    kind: 'literal',
    name: 'project codename',
    query: 'Perihelion',
    why: 'An invented name no model has seen in training; it has only the context around it.',
  },
  {
    expected: [4],
    kind: 'paraphrase',
    name: 'is she a morning person',
    query: 'can we schedule an early stand-up with her',
    why: 'No shared vocabulary with the fact, which is the whole reason for embedding it.',
  },
  {
    expected: [2],
    kind: 'paraphrase',
    name: 'when is she back',
    query: 'when will she be available again',
    why: 'The fact says parental leave until a date; the query says none of those words.',
  },
  {
    expected: [6],
    kind: 'paraphrase',
    name: 'why is she slow to reply',
    query: 'is there a reason she is typing less than usual',
    why: 'An injury explains a behaviour the query describes without naming it.',
  },
  {
    expected: [5],
    kind: 'paraphrase',
    name: 'how should I give feedback',
    query: 'what tone should I use when critiquing her pull request',
    why: 'A preference about review style, asked in the words of the situation.',
  },
  {
    expected: [7],
    kind: 'paraphrase',
    name: 'did the streaming work happen',
    query: 'did they ever finish moving to a message broker',
    why: 'A dropped decision must still answer the question it was a decision about.',
  },
  {
    expected: [19],
    kind: 'paraphrase',
    name: 'how should I address her',
    query: 'is there a nickname I should avoid using for her',
    why: 'The fact names the nickname; the query names only the category.',
  },
  {
    expected: [0, 1],
    kind: 'ambiguous',
    name: 'which database',
    query: 'what database does she use',
    why: 'Two facts answer and a third about staging size competes for the same words.',
  },
  {
    expected: [4, 22],
    kind: 'ambiguous',
    name: 'when does she work',
    query: 'what hours does she work best',
    why: 'Two facts say the same thing differently; both belong in the answer.',
  },
  {
    expected: [15, 28],
    kind: 'ambiguous',
    name: 'how does she like to communicate',
    query: 'should I ping her for a quick call or write it up',
    why: 'Three facts touch communication style and the ranking has to surface the two that answer.',
  },
  {
    expected: [3],
    kind: 'ambiguous',
    name: 'where is she based',
    query: 'where is she located',
    why: 'Competes with the Hetzner fact, which is where her server is and not where she is.',
  },
  {
    expected: [],
    kind: 'unanswerable',
    name: 'favourite film',
    query: 'what is her favourite film',
    why: 'Nothing answers it. What comes back anyway is the budget a recall would waste.',
  },
  {
    expected: [],
    kind: 'unanswerable',
    name: 'driving licence',
    query: 'does she have a driving licence',
    why: 'Plausible-sounding and absent, which is the shape that produces confident noise.',
  },
  {
    expected: [],
    kind: 'unanswerable',
    name: 'unrelated trivia',
    query: 'what is the capital of Peru',
    why: 'Not about her at all; a memory with nothing to say should say nothing.',
  },
  {
    expected: [],
    kind: 'unanswerable',
    name: 'her salary',
    query: 'how much is she paid',
    why: 'Shares vocabulary with the payments domain fact without being answered by it.',
  },
]);

/**
 * A longitudinal slice the uniformly-dated semantic corpus cannot represent.
 *
 * The full corpus is retained because this model's few-thousandths near-tie is
 * sensitive to batch geometry. Only age changes: the old, unused on-call detail
 * currently beats the meeting preference for the paraphrase. Decay should
 * settle that tie without hiding the same old fact when asked for directly.
 */
const DECAY_FACTS: readonly SeedFact[] = Object.freeze(
  RETRIEVAL_FACTS.map((fact, index) =>
    Object.freeze({
      ...fact,
      createdAt: index === 29 ? '2023-01-01T00:00:00.000Z' : '2026-08-20T00:00:00.000Z',
    }),
  ),
);
const DECAY_CASES: readonly RetrievalCase[] = Object.freeze([
  {
    expected: [4],
    kind: 'paraphrase',
    name: 'current schedule beats stale near-match',
    query: 'can we schedule an early stand-up with her',
    why: 'A stale, unused near-match must not outrank the current preference it only resembles.',
  },
  {
    expected: [29],
    kind: 'literal',
    name: 'stale fact remains directly answerable',
    query: 'on-call rotation',
    why: 'Decay changes close ranks; it must not erase an old fact when the question names it.',
  },
]);
const DECAY_EVALUATION_AT = new Date('2026-08-29T16:00:00.000Z');
const DEFAULT_EVALUATION_AT = new Date('2026-03-04T09:00:00.000Z');

function reciprocalRank(ranked: readonly number[], expected: readonly number[]): number {
  const position = ranked.findIndex((factId) => expected.includes(factId));
  return position === -1 ? 0 : 1 / (position + 1);
}

function recallAt(ranked: readonly number[], expected: readonly number[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((factId) => top.has(factId)).length / expected.length;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Aggregates over a set of cases.
 *
 * Recall and rank are averaged over the answerable cases only. Scoring an
 * unanswerable query for recall would hand a free 1.0 — there is nothing to
 * miss — and the average would rise the more of them the corpus held. What
 * those cases measure instead is `noise`: how many facts came back when none
 * should have.
 */
function aggregate(results: readonly RetrievalCaseResult[]): Score {
  const answerable = results.filter((result) => result.case.expected.length > 0);
  const unanswerable = results.filter((result) => result.case.expected.length === 0);
  const nearest = results.map((result) => result.score.nearest).filter(Number.isFinite);
  return {
    mrr: average(answerable.map((result) => result.score.mrr)),
    nearest: nearest.length === 0 ? Number.NaN : average(nearest),
    noise: average(unanswerable.map((result) => result.score.noise)),
    recall: average(answerable.map((result) => result.score.recall)),
  };
}

/** Seeds one scope with the corpus and returns the id each fact was given. */
async function seed(
  store: SemanticStore,
  scope: Scope,
  embedding: EmbeddingModel,
  facts: readonly SeedFact[],
): Promise<readonly number[]> {
  const embedded = await embedding.embed(facts.map((fact) => fact.text));
  const ids: number[] = [];
  for (const [index, fact] of facts.entries()) {
    const at = fact.createdAt === undefined ? DEFAULT_EVALUATION_AT : new Date(fact.createdAt);
    if (!Number.isFinite(at.getTime()))
      throw new TypeError('A retrieval seed has an invalid date.');
    const episodeId = await store.recordEpisode(scope, {
      completedAt: at.toISOString(),
      runId: `retrieval-eval-${String(index)}`,
      sessionId: 'retrieval-eval',
      startedAt: at.toISOString(),
      status: 'completed',
      transcript: 'seeded by the retrieval evaluation',
      trigger: 'user',
    });
    if (episodeId === undefined) throw new Error('The evaluation scope already holds an episode.');

    const written = await store.saveExtraction(
      episodeId,
      scope,
      [
        {
          draft: {
            confidence: 1,
            invalidates: [],
            kind: fact.kind,
            text: fact.text,
            validFrom: at.toISOString(),
          },
          vector: embedded.vectors[index] ?? [],
        },
      ],
      [],
      at,
    );
    const factId = written[0];
    if (factId === undefined) throw new Error('A retrieval seed fact was not written.');
    ids.push(factId);
  }

  await store.recordAccesses(
    facts.flatMap((fact, index) => {
      const factId = ids[index];
      if (factId === undefined || fact.lastAccessedAt === undefined) return [];
      return [
        {
          accessedAt: fact.lastAccessedAt,
          count: fact.accessCount ?? 1,
          factId,
          scope,
        },
      ];
    }),
  );

  const repetitions = Math.max(...facts.map((fact) => fact.repetitions ?? 1));
  for (let repetition = 1; repetition < repetitions; repetition += 1) {
    const reinforced = facts.flatMap((fact, index) => {
      const factId = ids[index];
      return factId !== undefined && (fact.repetitions ?? 1) > repetition
        ? [{ confidence: 1, factId }]
        : [];
    });
    if (reinforced.length === 0) continue;
    const supportId = await store.recordEpisode(scope, {
      completedAt: DEFAULT_EVALUATION_AT.toISOString(),
      runId: `retrieval-eval-support-${String(repetition)}`,
      sessionId: 'retrieval-eval',
      startedAt: DEFAULT_EVALUATION_AT.toISOString(),
      status: 'completed',
      transcript: 'independent repetition seeded by the retrieval evaluation',
      trigger: 'user',
    });
    if (supportId === undefined) throw new Error('A support episode was retained twice.');
    await store.saveExtraction(supportId, scope, [], reinforced, DEFAULT_EVALUATION_AT);
  }
  return ids;
}

interface RetrievalOptions {
  /** Ranking time. Omitted to provide the no-decay ablation. */
  readonly at?: Date;
  readonly cases?: readonly RetrievalCase[];
  readonly facts?: readonly SeedFact[];
  /**
   * Drop neighbours further than this, as a relevance floor would.
   *
   * Swept by the eval script rather than guessed: the floor trades recall for
   * quiet, and the only way to choose it is to see both sides of that trade at
   * every value over a corpus that contains questions with no answer.
   */
  readonly maxDistance?: number;
}

/**
 * Runs the cases against the path a conversation actually takes.
 *
 * There used to be three columns here — a text arm, a vector arm and their
 * fusion — because the question was which of them earned its place. That
 * question was answered against this corpus and the text arm lost, so what is
 * left measures one retrieval rather than pretending to compare several.
 */
async function evaluateRetrieval(
  store: SemanticStore,
  embedding: EmbeddingModel,
  scope: Scope,
  options: RetrievalOptions = {},
): Promise<RetrievalReport> {
  const facts = options.facts ?? RETRIEVAL_FACTS;
  const cases = options.cases ?? RETRIEVAL_CASES;
  const ids = await seed(store, scope, embedding, facts);
  const results: RetrievalCaseResult[] = [];

  for (const retrievalCase of cases) {
    const expected = retrievalCase.expected.flatMap((index) => {
      const id = ids[index];
      return id === undefined ? [] : [id];
    });

    const embedded = await embedding.embed([retrievalCase.query]);
    // The floor is the store's, so a sweep measures the same filter production
    // applies rather than a second one written for the evaluation.
    const found = await store.searchVector(
      scope,
      embedded.vectors[0] ?? [],
      TOP_K,
      options.maxDistance ?? NO_FLOOR,
      options.at,
    );
    const nearest = found;
    const ranked = nearest.map(({ factId }) => factId);
    const score: Score = {
      mrr: reciprocalRank(ranked, expected),
      nearest: nearest[0]?.distance ?? Number.NaN,
      noise: Math.min(ranked.length, TOP_K),
      recall: recallAt(ranked, expected, TOP_K),
    };

    results.push({
      case: retrievalCase,
      // An unanswerable case passes only by bringing nothing back, which today
      // nothing does. It is scored as a failure so the gap stays visible.
      passed: retrievalCase.expected.length === 0 ? score.noise === 0 : score.recall === 1,
      score,
    });
  }

  return Object.freeze({
    byKind: Object.freeze(
      CASE_KINDS.map((kind) => {
        const scoped = results.filter((result) => result.case.kind === kind);
        return { kind, score: aggregate(scoped), total: scoped.length };
      }),
    ),
    cases: Object.freeze(results),
    passed: results.filter((result) => result.passed).length,
    score: aggregate(results),
    total: results.length,
  });
}

export {
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
};

export type {
  CaseKind,
  KindScore,
  RetrievalCase,
  RetrievalCaseResult,
  RetrievalOptions,
  RetrievalReport,
  Score,
  SeedFact,
};
