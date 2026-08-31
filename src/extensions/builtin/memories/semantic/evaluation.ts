import { extract } from './extraction';

import type { FACT_KINDS } from './extraction';
import type { DraftFact, StoredFact } from './store';
import type { ChatModel } from '@nox/extension-api';

type FactKind = (typeof FACT_KINDS)[number];

/**
 * One statement a turn should have produced, described by what it must say
 * rather than by its exact wording.
 *
 * A model will not phrase a fact the same way twice, and pinning the string
 * would make the corpus fail on rewordings that are perfectly correct. What can
 * be asserted is that the statement carries the things without which it is
 * useless read alone: the name, the subject, the resolved date.
 */
interface ExpectedFact {
  readonly kind?: FactKind;
  /** Each must appear in the fact's text, case- and accent-insensitively. */
  readonly mentions: readonly string[];
}

interface EvalCase {
  /** What is already believed, as the extractor will be shown it. */
  readonly existing: readonly StoredFact[];
  readonly expected: readonly ExpectedFact[];
  /** Ids of shown facts this turn should end. */
  readonly invalidates: readonly number[];
  readonly name: string;
  readonly reinforces?: readonly number[];
  readonly occurredAt: string;
  readonly transcript: string;
  /** Why this case is in the corpus, so a later failure is legible. */
  readonly why: string;
}

interface CaseResult {
  readonly case: EvalCase;
  readonly drafts: readonly DraftFact[];
  /** Ids the extractor ended that the case did not ask for, and the reverse. */
  readonly invalidationCorrect: boolean;
  /** Expected statements no draft carried. */
  readonly missed: readonly ExpectedFact[];
  readonly passed: boolean;
  readonly reinforcementCorrect: boolean;
  /** Drafts matching no expected statement: the over-extraction failure mode. */
  readonly spurious: readonly DraftFact[];
}

interface EvalReport {
  readonly cases: readonly CaseResult[];
  readonly invalidationAccuracy: number;
  readonly passed: number;
  readonly reinforcementAccuracy: number;
  /** Of everything extracted, how much was asked for. */
  readonly precision: number;
  /** Of everything asked for, how much was extracted. */
  readonly recall: number;
  readonly total: number;
}

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function satisfies(draft: DraftFact, expected: ExpectedFact): boolean {
  if (expected.kind !== undefined && draft.kind !== expected.kind) return false;
  const text = normalize(draft.text);
  return expected.mentions.every((mention) => text.includes(normalize(mention)));
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Scores one extraction, counting both directions of being wrong.
 *
 * Recall alone rewards a model that extracts everything it sees, which is the
 * failure this memory suffers from most: a store full of "the user asked about
 * Redis" is worse than an empty one, because every recall then spends its
 * budget on noise. So a draft matching nothing expected is counted against the
 * run, and the negative cases — turns that should yield nothing — are the ones
 * that make that count mean something.
 */
function scoreCase(evalCase: EvalCase, drafts: readonly DraftFact[]): CaseResult {
  const claimed = new Set<number>();
  const missed: ExpectedFact[] = [];
  const novel = drafts.filter((draft) => draft.reinforces === undefined);

  for (const expected of evalCase.expected) {
    const index = novel.findIndex(
      (draft, position) => !claimed.has(position) && satisfies(draft, expected),
    );
    if (index === -1) missed.push(expected);
    else claimed.add(index);
  }

  const spurious = novel.filter((_, position) => !claimed.has(position));
  const invalidationCorrect = sameIds(
    drafts.flatMap((draft) => [...draft.invalidates]),
    evalCase.invalidates,
  );
  const reinforcementCorrect = sameIds(
    drafts.flatMap((draft) => (draft.reinforces === undefined ? [] : [draft.reinforces])),
    evalCase.reinforces ?? [],
  );

  return {
    case: evalCase,
    drafts,
    invalidationCorrect,
    missed: Object.freeze(missed),
    passed:
      missed.length === 0 && spurious.length === 0 && invalidationCorrect && reinforcementCorrect,
    reinforcementCorrect,
    spurious: Object.freeze(spurious),
  };
}

function summarize(results: readonly CaseResult[]): EvalReport {
  const expectedTotal = results.reduce((sum, result) => sum + result.case.expected.length, 0);
  const missedTotal = results.reduce((sum, result) => sum + result.missed.length, 0);
  const draftTotal = results.reduce(
    (sum, result) => sum + result.drafts.filter((draft) => draft.reinforces === undefined).length,
    0,
  );
  const spuriousTotal = results.reduce((sum, result) => sum + result.spurious.length, 0);

  return {
    cases: results,
    invalidationAccuracy:
      results.length === 0
        ? 1
        : results.filter((result) => result.invalidationCorrect).length / results.length,
    passed: results.filter((result) => result.passed).length,
    precision: draftTotal === 0 ? 1 : (draftTotal - spuriousTotal) / draftTotal,
    recall: expectedTotal === 0 ? 1 : (expectedTotal - missedTotal) / expectedTotal,
    reinforcementAccuracy:
      results.length === 0
        ? 1
        : results.filter((result) => result.reinforcementCorrect).length / results.length,
    total: results.length,
  };
}

/** Runs the corpus through one model, in order, and scores what came back. */
async function evaluate(
  model: ChatModel,
  cases: readonly EvalCase[],
  signal?: AbortSignal,
): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const drafts = await extract({
      existing: evalCase.existing,
      model,
      occurredAt: new Date(evalCase.occurredAt),
      ...(signal === undefined ? {} : { signal }),
      transcript: evalCase.transcript,
    });
    results.push(scoreCase(evalCase, drafts));
  }
  return summarize(results);
}

function believed(factId: number, kind: FactKind, text: string): StoredFact {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    factId,
    kind,
    text,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: undefined,
  };
}

const TURN_DATE = '2026-03-04T09:00:00.000Z';

/**
 * The corpus.
 *
 * Half of it is turns that must produce nothing. That balance is deliberate:
 * the prompt's hard job is not noticing that somebody stated a preference, it
 * is declining to invent one from a greeting, a question, or something the
 * assistant said. A corpus of only positive cases scores best for a model that
 * extracts constantly, which is the model that ruins the store.
 */
const EVAL_CORPUS: readonly EvalCase[] = Object.freeze([
  {
    existing: [],
    expected: [{ kind: 'preference', mentions: ['jasmine'] }],
    invalidates: [],
    name: 'plain preference',
    occurredAt: TURN_DATE,
    transcript: 'User (Ana <web:ana>): I only drink jasmine tea, never coffee.\nAssistant: Noted.',
    why: 'The base case: something stated plainly about oneself is worth keeping.',
  },
  {
    existing: [],
    expected: [],
    invalidates: [],
    name: 'greeting reveals nothing',
    occurredAt: TURN_DATE,
    transcript: 'User (Ana <web:ana>): hey, are you there?\nAssistant: I am. What do you need?',
    why: 'Over-extraction is the failure that ruins a store; a greeting must cost nothing.',
  },
  {
    existing: [],
    expected: [],
    invalidates: [],
    name: 'a question is not a self-revelation',
    occurredAt: TURN_DATE,
    transcript:
      'User (Ana <web:ana>): what is the difference between WAL and rollback journal in SQLite?\n' +
      'Assistant: WAL lets readers proceed during a write...',
    why: 'What a turn was about is not a fact about the person. This is the commonest false positive.',
  },
  {
    existing: [],
    expected: [],
    invalidates: [],
    name: 'the assistant is not a source',
    occurredAt: TURN_DATE,
    transcript:
      'User (Ana <web:ana>): summarise that page for me.\n' +
      'Assistant: The page says Postgres 17 ships incremental backup and the author lives in Oslo.',
    why: 'Only what the person revealed. Facts about third parties from assistant output are not memory.',
  },
  {
    existing: [believed(1, 'state', 'Ana lives in Madrid.')],
    expected: [{ kind: 'state', mentions: ['Lisbon'] }],
    invalidates: [1],
    name: 'a move ends the earlier address',
    occurredAt: TURN_DATE,
    transcript: 'User (Ana <web:ana>): I moved to Lisbon last month, finally out of Madrid.',
    why: 'The bitemporal case: the new statement must end the old rather than sit beside it.',
  },
  {
    existing: [believed(1, 'preference', 'Ana prefers TypeScript for backend work.')],
    expected: [{ mentions: ['Rust'] }],
    invalidates: [],
    name: 'a second preference does not end the first',
    occurredAt: TURN_DATE,
    reinforces: [1],
    transcript:
      'User (Ana <web:ana>): I have started using Rust for the parsing work. ' +
      'Still TypeScript everywhere else though.',
    why: 'Invalidation must not fire on merely related facts; both are true at once here.',
  },
  {
    existing: [],
    expected: [{ mentions: ['Ana'] }],
    invalidates: [],
    name: 'pronouns are resolved',
    occurredAt: TURN_DATE,
    transcript:
      'User (Ana <web:ana>): my sister set it up, but I am the one who maintains the cluster.',
    why: 'A stored statement is read alone months later; "I" in it is useless.',
  },
  {
    existing: [],
    expected: [{ kind: 'decision', mentions: ['Postgres'] }],
    invalidates: [],
    name: 'a settled decision',
    occurredAt: TURN_DATE,
    transcript:
      'User (Ana <web:ana>): we decided it: Postgres for the new service, not Mongo. ' +
      'Do not suggest Mongo again.',
    why: 'Decisions are what later work depends on, and the kind that must survive a session.',
  },
  {
    existing: [],
    expected: [{ mentions: ['2026-03-11'] }],
    invalidates: [],
    name: 'relative dates are resolved',
    occurredAt: TURN_DATE,
    transcript: 'User (Ana <web:ana>): I am on leave from next Wednesday for two weeks.',
    why: 'This is why the turn date is in the prompt: "next Wednesday" cannot be resolved without it.',
  },
  {
    existing: [],
    expected: [{ kind: 'identity', mentions: ['Ana'] }, { mentions: ['Berlin'] }],
    invalidates: [],
    name: 'two statements in one turn',
    occurredAt: TURN_DATE,
    transcript:
      'User (Ana <web:ana>): I am the platform lead here, and the team is all in Berlin now.',
    why: 'A turn is not limited to one fact, and collapsing them loses one.',
  },
]);

export { EVAL_CORPUS, evaluate, scoreCase, summarize };

export type { CaseResult, EvalCase, EvalReport, ExpectedFact, FactKind };
