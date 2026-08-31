import { describe, expect, test } from 'bun:test';

import { EVAL_CORPUS, scoreCase, summarize } from './evaluation';

import type { DraftFact } from './store';

function draft(text: string, kind = 'state', invalidates: readonly number[] = []): DraftFact {
  return { confidence: 0.9, invalidates, kind, text, validFrom: '2026-03-04T09:00:00.000Z' };
}

function caseNamed(name: string) {
  const found = EVAL_CORPUS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`No corpus case named ${name}.`);
  return found;
}

describe('the corpus', () => {
  test('spends half its weight on turns that must produce nothing', () => {
    const negative = EVAL_CORPUS.filter((entry) => entry.expected.length === 0);

    // The prompt's hard job is declining to invent facts. A corpus of only
    // positive cases scores best for the model that extracts constantly, which
    // is exactly the model that fills a store with noise.
    expect(negative.length).toBeGreaterThanOrEqual(3);
    expect(EVAL_CORPUS.length).toBeGreaterThanOrEqual(10);
  });

  test('says why each case exists, so a later failure is legible', () => {
    for (const entry of EVAL_CORPUS) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.name).not.toBe('');
    }
  });

  test('only ever names an existing id in a belief action', () => {
    for (const entry of EVAL_CORPUS) {
      const shown = new Set(entry.existing.map((fact) => fact.factId));
      for (const id of entry.invalidates) expect(shown.has(id)).toBeTrue();
      for (const id of entry.reinforces ?? []) expect(shown.has(id)).toBeTrue();
    }
  });
});

describe('scoreCase', () => {
  test('passes an extraction that carries what was asked for', () => {
    const result = scoreCase(caseNamed('plain preference'), [
      draft('Ana drinks only jasmine tea and never coffee.', 'preference'),
    ]);

    expect(result.passed).toBeTrue();
    expect(result.missed).toEqual([]);
    expect(result.spurious).toEqual([]);
  });

  test('matches on meaning carried, not on exact wording', () => {
    // Two correct extractions phrased differently must both pass, or the corpus
    // fails on rewordings that are not mistakes.
    for (const text of [
      'Ana only ever drinks jasmine tea.',
      'Jasmine tea is the only thing Ana drinks; she avoids coffee.',
    ]) {
      expect(
        scoreCase(caseNamed('plain preference'), [draft(text, 'preference')]).passed,
      ).toBeTrue();
    }
  });

  test('is not fooled by accents or casing', () => {
    expect(
      scoreCase(caseNamed('a move ends the earlier address'), [
        draft('Ana se mudó a LISBOA... to Lisbon.', 'state', [1]),
      ]).passed,
    ).toBeTrue();
  });

  test('counts an invented fact against the run', () => {
    const result = scoreCase(caseNamed('greeting reveals nothing'), [
      draft('Ana greets the assistant.', 'state'),
    ]);

    // The failure that ruins a store: nothing was asked for and something came
    // back. Recall alone would score this run perfect.
    expect(result.passed).toBeFalse();
    expect(result.spurious).toHaveLength(1);
    expect(result.missed).toEqual([]);
  });

  test('fails a turn whose statement was not extracted', () => {
    const result = scoreCase(caseNamed('plain preference'), []);

    expect(result.passed).toBeFalse();
    expect(result.missed).toHaveLength(1);
  });

  test('fails when a contradiction was stored beside what it replaced', () => {
    const result = scoreCase(caseNamed('a move ends the earlier address'), [
      draft('Ana lives in Lisbon.', 'state'),
    ]);

    // The statement is right and the bookkeeping is wrong, which is worse than
    // missing it: both addresses now answer "where does she live".
    expect(result.invalidationCorrect).toBeFalse();
    expect(result.passed).toBeFalse();
  });

  test('fails when an unrelated fact was retired', () => {
    const result = scoreCase(caseNamed('a second preference does not end the first'), [
      draft('Ana uses Rust for parsing work.', 'preference', [1]),
    ]);

    expect(result.invalidationCorrect).toBeFalse();
  });

  test('scores reinforcement separately from creating another fact', () => {
    const repeated = {
      ...draft('Ana still prefers TypeScript for backend work.', 'preference'),
      reinforces: 1,
    };
    const correct = scoreCase(caseNamed('a second preference does not end the first'), [
      draft('Ana uses Rust for parsing work.', 'preference'),
      repeated,
    ]);
    const unexpected = scoreCase(caseNamed('plain preference'), [
      draft('Ana drinks jasmine tea.', 'preference'),
      repeated,
    ]);

    expect(correct.passed).toBeTrue();
    expect(correct.spurious).toEqual([]);
    expect(unexpected.reinforcementCorrect).toBeFalse();
    expect(unexpected.passed).toBeFalse();
  });

  test('does not let one draft satisfy two expectations', () => {
    const result = scoreCase(caseNamed('two statements in one turn'), [
      draft('Ana is the platform lead and the team is in Berlin.', 'identity'),
    ]);

    // One statement carrying both is one statement: the second is still missing
    // and would be retrieved on its own only by accident.
    expect(result.missed).toHaveLength(1);
    expect(result.passed).toBeFalse();
  });

  test('holds the kind when the case names one', () => {
    expect(
      scoreCase(caseNamed('a settled decision'), [draft('Ana chose Postgres.', 'preference')])
        .passed,
    ).toBeFalse();
  });
});

describe('summarize', () => {
  test('separates extracting too little from extracting too much', () => {
    const missedOne = scoreCase(caseNamed('plain preference'), []);
    const inventedOne = scoreCase(caseNamed('greeting reveals nothing'), [draft('Ana said hi.')]);

    expect(summarize([missedOne])).toMatchObject({ passed: 0, precision: 1, recall: 0 });
    expect(summarize([inventedOne])).toMatchObject({ passed: 0, precision: 0, recall: 1 });
  });

  test('reports a clean run as clean', () => {
    const report = summarize([
      scoreCase(caseNamed('greeting reveals nothing'), []),
      scoreCase(caseNamed('plain preference'), [draft('Ana drinks jasmine tea.', 'preference')]),
    ]);

    expect(report).toMatchObject({
      invalidationAccuracy: 1,
      passed: 2,
      precision: 1,
      recall: 1,
      reinforcementAccuracy: 1,
      total: 2,
    });
  });
});
