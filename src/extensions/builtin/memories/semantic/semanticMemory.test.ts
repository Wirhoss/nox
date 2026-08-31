import { describe, expect, test } from 'bun:test';

import { MemoryExtensionStorageProvider } from '../../../storage';
import { extract } from './extraction';
import { SemanticMemory } from './semanticMemory';
import { SemanticStore } from './store';

import type {
  ChatModel,
  EmbeddingModel,
  MemoryRetainRequest,
  Message,
  PrincipalRef,
} from '@nox/extension-api';

const ALICE: PrincipalRef = { issuer: 'web', subject: 'alice' };
const BOB: PrincipalRef = { issuer: 'web', subject: 'bob' };
const DIMENSIONS = 8;

/**
 * A deterministic embedder: each text becomes its own character histogram,
 * normalized. Texts sharing vocabulary end up near each other, which is the
 * only property the retrieval under test actually depends on.
 */
function fakeEmbedding(calls: string[][] = []): EmbeddingModel {
  return {
    config: () => ({ dimensions: DIMENSIONS, kind: 'embedding', modelId: 'fake' }),
    embed: (texts) => {
      calls.push([...texts]);
      return Promise.resolve({
        dimensions: DIMENSIONS,
        modelId: 'fake',
        vectors: texts.map((value) => histogram(value)),
      });
    },
    reference: { model: 'fake', provider: 'test' },
  };
}

function histogram(value: string): number[] {
  const buckets = Array.from({ length: DIMENSIONS }, () => 0);
  for (const character of value.toLowerCase()) {
    const bucket = (character.codePointAt(0) ?? 0) % DIMENSIONS;
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  const length = Math.hypot(...buckets);
  return length === 0 ? buckets : buckets.map((count) => count / length);
}

/** Separates one old topic sharply from a large unrelated recent tail. */
function topicalEmbedding(): EmbeddingModel {
  return {
    config: () => ({ dimensions: DIMENSIONS, kind: 'embedding', modelId: 'topical' }),
    embed: (texts) =>
      Promise.resolve({
        dimensions: DIMENSIONS,
        modelId: 'topical',
        vectors: texts.map((text) => topicalVector(text)),
      }),
    reference: { model: 'topical', provider: 'test' },
  };
}

function topicalVector(text: string): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) =>
    index === (text.toLowerCase().includes('madrid') ? 0 : 1) ? 1 : 0,
  );
}

/** A chat model that replays scripted extractions, one per call. */
function fakeChat(answers: readonly string[], seen: string[] = []): ChatModel {
  let call = 0;
  return {
    config: () => ({
      inputModalities: ['text'],
      kind: 'chat',
      modelId: 'fake',
      outputModalities: ['text'],
    }),
    reference: { model: 'fake', provider: 'test' },
    stream: (_prompt, history) => {
      seen.push(history.map((message) => messageText(message)).join('\n'));
      const answer = answers[Math.min(call, answers.length - 1)] ?? '{"facts": []}';
      call += 1;
      return {
        completed: Promise.resolve([
          {
            content: [{ text: answer, type: 'text' }],
            createdAt: new Date(),
            messageId: `answer-${String(call)}`,
            role: 'assistant',
          },
        ]),
      } as never;
    },
  };
}

function messageText(message: Message): string {
  if (!('content' in message) || !Array.isArray(message.content)) return '';
  return message.content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
    )
    .join('');
}

function retainRequest(
  principal: PrincipalRef,
  runId: string,
  said: string,
  agentId = 'agent-a',
): MemoryRetainRequest {
  const at = new Date('2026-03-01T10:00:00.000Z');
  return {
    completedAt: at,
    messages: [
      { createdAt: at, messageId: `${runId}-u`, principal, role: 'user', text: said },
      { createdAt: at, messageId: `${runId}-a`, role: 'assistant', text: 'Noted.' },
    ],
    runId,
    scope: { agentId, principal, sessionId: `session-${runId}` },
    startedAt: at,
    status: 'completed',
    trigger: 'user',
  };
}

function recallRequest(principal: PrincipalRef, query: string, agentId = 'agent-a') {
  return {
    context: [],
    maxTokens: 500,
    query,
    scope: { agentId, principal, sessionId: 'current' },
    signal: AbortSignal.timeout(10_000),
  };
}

interface Harness {
  readonly embedCalls: string[][];
  readonly memory: SemanticMemory;
  readonly prompts: string[];
  readonly store: SemanticStore;
}

async function harness(answers: readonly string[], embedding?: EmbeddingModel): Promise<Harness> {
  const provider = new MemoryExtensionStorageProvider();
  const storage = await provider.forExtension({
    extensionId: 'nox.memory.semantic',
    migrations: `${import.meta.dir}/migrations`,
  });
  const embedCalls: string[][] = [];
  const prompts: string[] = [];
  const store = new SemanticStore(storage);
  const memory = new SemanticMemory({
    chat: fakeChat(answers, prompts),
    embedding: embedding ?? fakeEmbedding(embedCalls),
    // The stand-in embedder has its own geometry; the floor is measured against
    // a real model in the retrieval evaluation, not asserted here.
    maxDistance: 2,
    maxRecallFacts: 10,
    // Off here, and deliberately. These stand-in embedders place every text on
    // one of two axes, so a hundred distinct facts share a single vector — a
    // geometry no real model produces and the one thing merging must never see.
    // Consolidation is exercised against vectors chosen for it instead.
    mergeDistance: 0,
    store,
  });
  await memory.start();
  return { embedCalls, memory, prompts, store };
}

async function seedFact(
  store: SemanticStore,
  run: number,
  text: string,
  vector: readonly number[],
): Promise<number> {
  const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + run);
  const scope = { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject };
  const episodeId = await store.recordEpisode(scope, {
    completedAt: at.toISOString(),
    runId: `seed-${String(run)}`,
    sessionId: 'seed',
    startedAt: at.toISOString(),
    status: 'completed',
    transcript: `User: ${text}`,
    trigger: 'migration',
  });
  if (episodeId === undefined) throw new Error('Seed episode already existed.');
  const written = await store.saveExtraction(
    episodeId,
    scope,
    [
      {
        draft: {
          confidence: 0.9,
          invalidates: [],
          kind: 'state',
          text,
          validFrom: at.toISOString(),
        },
        vector,
      },
    ],
    [],
    at,
  );
  const factId = written[0];
  if (factId === undefined) throw new Error('Seed fact was not written.');
  return factId;
}

async function seedOverflowingBeliefs(store: SemanticStore): Promise<number> {
  const oldFactId = await seedFact(
    store,
    0,
    'Alice lives in Madrid.',
    topicalVector('Alice lives in Madrid.'),
  );
  for (let index = 1; index <= 100; index += 1) {
    const text = `Alice completed archived task ${String(index)}.`;
    await seedFact(store, index, text, topicalVector(text));
  }
  return oldFactId;
}

/** Retention only queues; the background pass is what extracts. */
async function settle(memory: SemanticMemory): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await Bun.sleep(2);
  await memory.dispose();
}

describe('SemanticMemory', () => {
  test('remembers a fact rather than the turn it came from', async () => {
    const { memory } = await harness([
      '{"facts": [{"kind": "preference", "text": "Alice prefers jasmine tea.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'tea', 'I always drink jasmine tea, never coffee.'));
    await settle(memory);

    const recalled = await memory.recall(recallRequest(ALICE, 'what tea does she like'));

    // The statement, not the transcript it was said in.
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.memories[0]?.text).toBe('[preference] Alice prefers jasmine tea.');
    expect(recalled.memories[0]?.metadata).toMatchObject({
      kind: 'preference',
      since: '2026-03-01T10:00:00.000Z',
    });
    expect(recalled.memories[0]?.metadata).toHaveProperty('distance');
  });

  test('buffers successful recalls and persists one aggregate on disposal', async () => {
    const { memory, store } = await harness(['{"facts": []}']);
    const text = 'Alice prefers jasmine tea.';
    const factId = await seedFact(store, 0, text, histogram(text));

    const recalled = await memory.recall(recallRequest(ALICE, 'what tea does Alice prefer'));
    await store.recordAccesses([
      {
        accessedAt: new Date().toISOString(),
        count: 99,
        factId,
        scope: { agentId: 'agent-a', issuer: BOB.issuer, subject: BOB.subject },
      },
    ]);
    const beforeFlush = await store.searchVector(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      histogram('what tea does Alice prefer'),
      10,
      2,
    );

    expect(recalled.memories[0]?.metadata).toMatchObject({ accessCount: 0 });
    expect(beforeFlush.find((fact) => fact.factId === factId)).toMatchObject({
      accessCount: 0,
      lastAccessedAt: undefined,
    });

    await memory.dispose();
    const afterFlush = await store.searchVector(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      histogram('what tea does Alice prefer'),
      10,
      2,
    );
    const accessed = afterFlush.find((fact) => fact.factId === factId);
    expect(accessed?.accessCount).toBe(1);
    expect(accessed?.lastAccessedAt).toBeDefined();
  });

  test('merges a repeated fact into its provenance instead of storing it twice', async () => {
    const { memory, store } = await harness([
      '{"facts": [{"kind": "preference", "text": "Alice prefers jasmine tea.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
      '{"facts": [{"kind": "preference", "text": "Alice prefers jasmine tea.", ' +
        '"confidence": 0.8, "invalidates": [], "reinforces": 1}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'tea-once', 'I prefer jasmine tea.'));
    await Bun.sleep(60);
    await memory.retain(retainRequest(ALICE, 'tea-again', 'Jasmine tea is still my preference.'));
    await settle(memory);

    const facts = await store.liveFacts(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      10,
    );
    const recalled = await memory.recall(recallRequest(ALICE, 'what tea does she prefer'));

    expect(facts).toHaveLength(1);
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.memories[0]?.metadata).toMatchObject({ supportCount: 2 });
  });

  test('reinforces a semantic neighbour older than the recent belief window', async () => {
    const answers = [''];
    const { memory, prompts, store } = await harness(answers, topicalEmbedding());
    const oldFactId = await seedOverflowingBeliefs(store);
    answers[0] =
      '{"facts": [{"kind": "state", "text": "Alice lives in Madrid.", ' +
      `"confidence": 0.8, "invalidates": [], "reinforces": ${String(oldFactId)}}]}`;

    await memory.retain(retainRequest(ALICE, 'still-madrid', 'I still live in Madrid.'));
    await settle(memory);

    const recalled = await memory.recall(recallRequest(ALICE, 'where in Madrid does Alice live'));
    const oldFact = recalled.memories.find((entry) => entry.id === String(oldFactId));
    expect(prompts[0]).toContain(`${String(oldFactId)}. [state] Alice lives in Madrid.`);
    expect(oldFact?.metadata).toMatchObject({ supportCount: 2 });
    expect(
      await store.liveFacts(
        { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
        200,
      ),
    ).toHaveLength(101);
  });

  test('supersedes a semantic neighbour older than the recent belief window', async () => {
    const answers = [''];
    const { memory, prompts, store } = await harness(answers, topicalEmbedding());
    const oldFactId = await seedOverflowingBeliefs(store);
    answers[0] =
      '{"facts": [{"kind": "state", "text": "Alice lives in Lisbon.", ' +
      `"confidence": 0.9, "invalidates": [${String(oldFactId)}]}]}`;

    await memory.retain(
      retainRequest(ALICE, 'moved-lisbon', 'I moved from Madrid and now live in Lisbon.'),
    );
    await settle(memory);

    const live = await store.liveFacts(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      200,
    );
    expect(prompts[0]).toContain(`${String(oldFactId)}. [state] Alice lives in Madrid.`);
    expect(live.some((fact) => fact.factId === oldFactId)).toBeFalse();
    expect(live.some((fact) => fact.text === 'Alice lives in Lisbon.')).toBeTrue();
  });

  test('ends a fact a later turn contradicted, and keeps it answerable', async () => {
    const { memory } = await harness([
      '{"facts": [{"kind": "state", "text": "Alice lives in Madrid.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
      '{"facts": [{"kind": "state", "text": "Alice lives in Lisbon.", ' +
        '"confidence": 0.9, "invalidates": [1]}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'madrid', 'I live in Madrid.'));
    await Bun.sleep(60);
    await memory.retain(retainRequest(ALICE, 'lisbon', 'I moved to Lisbon last month.'));
    await settle(memory);

    const recalled = await memory.recall(recallRequest(ALICE, 'where does she live'));

    // The whole point of the bitemporal columns: the old address is not deleted
    // and not returned. A store that only appended would hand the model both.
    expect(recalled.memories.map((entry) => entry.text)).toEqual([
      '[state] Alice lives in Lisbon.',
    ]);
  });

  test('never lets one principal reach another, in either arm', async () => {
    const { memory } = await harness([
      '{"facts": [{"kind": "identity", "text": "Alice is a cellist.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'cello', 'I play the cello.'));
    await settle(memory);

    const bob = await memory.recall(recallRequest(BOB, 'Alice is a cellist'));
    const otherAgent = await memory.recall(recallRequest(ALICE, 'cellist', 'agent-b'));

    expect(bob.memories).toEqual([]);
    expect(otherAgent.memories).toEqual([]);
  });

  test('stores the turn even when extraction answers nothing usable', async () => {
    const { memory, prompts } = await harness(['I am afraid I cannot help with that.']);
    await memory.retain(retainRequest(ALICE, 'noise', 'Hello there.'));
    await settle(memory);

    // Extraction ran and produced nothing; the episode is still recorded, which
    // is what lets a better prompt extract it later.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Hello there.');
  });

  test('retains the same run twice without doubling the corpus', async () => {
    const { memory, prompts } = await harness([
      '{"facts": [{"kind": "identity", "text": "Alice is a cellist.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'once', 'I play the cello.'));
    await memory.retain(retainRequest(ALICE, 'once', 'I play the cello.'));
    await settle(memory);

    expect(prompts).toHaveLength(1);
  });

  test('writes, searches, replaces, and retires facts only inside the caller scope', async () => {
    const { memory, store } = await harness(['{"facts": []}']);
    const signal = AbortSignal.timeout(10_000);
    const aliceScope = { agentId: 'agent-a', principal: ALICE, sessionId: 'editor' };
    const bobScope = { agentId: 'agent-a', principal: BOB, sessionId: 'editor' };

    const written = await memory.editor.write({
      kind: 'preference',
      scope: aliceScope,
      signal,
      text: 'Alice prefers jasmine tea.',
      validFrom: '2026-03-01T10:00:00+00:00',
    });
    const found = await memory.editor.search({
      limit: 5,
      query: 'what tea does Alice prefer',
      scope: aliceScope,
      signal,
    });

    expect(typeof written.id).toBe('string');
    expect(written).toMatchObject({
      kind: 'preference',
      validFrom: '2026-03-01T10:00:00.000Z',
    });
    expect(found).toMatchObject([{ id: written.id, text: 'Alice prefers jasmine tea.' }]);
    expect(await memory.editor.search({ limit: 5, query: 'tea', scope: bobScope, signal })).toEqual(
      [],
    );
    expect(
      await memory.editor.update({
        id: written.id,
        kind: 'preference',
        scope: bobScope,
        signal,
        text: 'Bob prefers coffee.',
      }),
    ).toBeUndefined();

    const replacement = await memory.editor.update({
      id: written.id,
      kind: 'preference',
      scope: aliceScope,
      signal,
      text: 'Alice prefers oolong tea.',
      validFrom: '2026-04-01T10:00:00Z',
    });
    if (replacement === undefined) throw new Error('Expected the live fact to be replaced.');

    const old = await store.factsByIds(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      [Number(written.id)],
    );
    expect(replacement).toMatchObject({
      kind: 'preference',
      text: 'Alice prefers oolong tea.',
      validFrom: '2026-04-01T10:00:00.000Z',
    });
    expect(old[0]?.validTo).toBe('2026-04-01T10:00:00.000Z');
    expect(await memory.editor.forget({ id: written.id, scope: aliceScope, signal })).toBeFalse();
    expect(await memory.editor.forget({ id: replacement.id, scope: bobScope, signal })).toBeFalse();
    expect(
      await memory.editor.forget({ id: replacement.id, scope: aliceScope, signal }),
    ).toBeTrue();
    expect(
      await store.liveFacts(
        { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
        10,
      ),
    ).toEqual([]);

    const scopes = await memory.inspector.scopes(signal);
    const facts = await memory.inspector.facts({
      limit: 10,
      offset: 0,
      scope: { agentId: 'agent-a', principal: ALICE },
      signal,
    });
    const episodes = await memory.inspector.episodes({
      limit: 10,
      offset: 0,
      scope: { agentId: 'agent-a', principal: ALICE },
      signal,
    });
    expect(scopes).toMatchObject([
      {
        agentId: 'agent-a',
        episodeCount: 3,
        factCount: 2,
        liveFactCount: 0,
        principal: ALICE,
      },
    ]);
    expect(facts.total).toBe(2);
    expect(facts.entries.find(({ id }) => id === written.id)).toMatchObject({
      invalidatedBy: replacement.id,
      provenance: [{ trigger: 'memory_write' }],
      supportCount: 1,
    });
    const replaced = facts.entries.find(({ id }) => id === replacement.id);
    expect(typeof replaced?.invalidatedEpisodeId).toBe('string');
    expect(replaced).toMatchObject({
      provenance: [{ trigger: 'memory_update' }],
    });
    expect(episodes).toMatchObject({
      entries: [
        { factIds: [], trigger: 'memory_forget' },
        { factIds: [replacement.id], trigger: 'memory_update' },
        { factIds: [written.id], trigger: 'memory_write' },
      ],
      total: 3,
    });
    await memory.dispose();
  });

  test('recalls nothing rather than failing when the embedding model is unreachable', async () => {
    const { memory, store } = await harness([
      '{"facts": [{"kind": "preference", "text": "Alice prefers jasmine tea.", ' +
        '"confidence": 0.9, "invalidates": []}]}',
    ]);
    await memory.retain(retainRequest(ALICE, 'tea', 'I drink jasmine tea.'));
    await settle(memory);

    const failing = new SemanticMemory({
      chat: fakeChat(['{"facts": []}']),
      embedding: {
        config: () => ({ dimensions: DIMENSIONS, kind: 'embedding', modelId: 'fake' }),
        embed: () => Promise.reject(new Error('endpoint down')),
        reference: { model: 'fake', provider: 'test' },
      },
      maxDistance: 2,
      maxRecallFacts: 10,
      store,
    });

    // This is the price of dropping the text arm, and it is deliberate: an
    // unreachable embedding model now means no memory for the turn rather than
    // a worse one. It must still be a quiet empty answer, because the runner
    // continues without memory and a thrown error would end the turn instead.
    const recalled = await failing.recall(recallRequest(ALICE, 'jasmine tea'));
    expect(recalled.memories).toEqual([]);
    await failing.dispose();
  });
});

describe('extract', () => {
  test('reads JSON a model wrapped in prose, and drops ids it was never shown', async () => {
    const drafts = await extract({
      existing: [],
      model: fakeChat([
        'Sure! Here is what I found:\n```json\n' +
          '{"facts": [{"kind": "state", "text": "Alice lives in Lisbon.", ' +
          '"confidence": 0.8, "invalidates": [99]}]}\n```',
      ]),
      occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      transcript: 'User: I moved to Lisbon.',
    });

    expect(drafts).toHaveLength(1);
    // 99 was never in the belief window, so it can retire nothing.
    expect(drafts[0]?.invalidates).toEqual([]);
    expect(drafts[0]?.validFrom).toBe('2026-03-01T10:00:00.000Z');
  });

  test('drops a reinforcement id the model was never shown', async () => {
    const drafts = await extract({
      existing: [],
      model: fakeChat([
        '{"facts": [{"kind": "state", "text": "Alice lives in Lisbon.", ' +
          '"confidence": 0.8, "invalidates": [], "reinforces": 99}]}',
      ]),
      occurredAt: new Date(),
      transcript: 'User: I still live in Lisbon.',
    });

    expect(drafts).toEqual([]);
  });

  test('answers nothing when the model returns something unusable', async () => {
    const drafts = await extract({
      existing: [],
      model: fakeChat(['no json here at all']),
      occurredAt: new Date(),
      transcript: 'User: hello',
    });

    expect(drafts).toEqual([]);
  });
});

describe('relevance floor', () => {
  /** A memory over a store somebody else already opened, so restarts are testable. */
  async function memoryOver(store: SemanticStore, embedCalls: string[][]): Promise<SemanticMemory> {
    const memory = new SemanticMemory({
      chat: fakeChat([]),
      embedding: fakeEmbedding(embedCalls),
      maxRecallFacts: 10,
      store,
    });
    await memory.start();
    return memory;
  }

  async function emptyStore(): Promise<SemanticStore> {
    const provider = new MemoryExtensionStorageProvider();
    return new SemanticStore(
      await provider.forExtension({
        extensionId: 'nox.memory.semantic',
        migrations: `${import.meta.dir}/migrations`,
      }),
    );
  }

  test('is measured from the model when configuration does not pin one', async () => {
    const store = await emptyStore();
    const embedCalls: string[][] = [];
    const memory = await memoryOver(store, embedCalls);

    const calibration = await store.calibratedFloor({
      dimensions: DIMENSIONS,
      model: 'fake',
      provider: 'test',
    });
    expect(calibration?.floor).toBeGreaterThan(0);
    expect(embedCalls).toHaveLength(1);
    await memory.dispose();
  });

  /** Measuring is a model call; it belongs to the model, not to every start. */
  test('is measured once and read back on the next start', async () => {
    const store = await emptyStore();
    const first = await memoryOver(store, []);
    await first.dispose();

    const embedCalls: string[][] = [];
    const second = await memoryOver(store, embedCalls);

    expect(embedCalls).toEqual([]);
    await second.dispose();
  });

  test('is not measured at all when an operator pinned one', async () => {
    const store = await emptyStore();
    const embedCalls: string[][] = [];
    const memory = new SemanticMemory({
      chat: fakeChat([]),
      embedding: fakeEmbedding(embedCalls),
      maxDistance: 1.1,
      maxRecallFacts: 10,
      store,
    });
    await memory.start();

    expect(embedCalls).toEqual([]);
    expect(
      await store.calibratedFloor({ dimensions: DIMENSIONS, model: 'fake', provider: 'test' }),
    ).toBeUndefined();
    await memory.dispose();
  });
});

/**
 * A turn that has just happened.
 *
 * Separate from `retainRequest`, whose fixed 2026-03-01 timestamp is months in
 * the past by the time anyone runs the suite — which makes every episode it
 * builds instantly overdue, and so useless for testing the pacing that decides
 * whether an episode is overdue.
 */
function freshRetainRequest(runId: string, said: string): MemoryRetainRequest {
  const at = new Date();
  return {
    completedAt: at,
    messages: [
      { createdAt: at, messageId: `${runId}-u`, principal: ALICE, role: 'user', text: said },
      { createdAt: at, messageId: `${runId}-a`, role: 'assistant', text: 'Noted.' },
    ],
    runId,
    scope: { agentId: 'agent-a', principal: ALICE, sessionId: `session-${runId}` },
    startedAt: at,
    status: 'completed',
    trigger: 'user',
  };
}

/** A memory whose pacing the test sets, and whose host activity it drives. */
async function pacedHarness(
  answers: readonly string[],
  dream: { episodes: number; idleSeconds: number; maxDelaySeconds: number },
  busy?: () => boolean,
): Promise<Harness> {
  const provider = new MemoryExtensionStorageProvider();
  const storage = await provider.forExtension({
    extensionId: 'nox.memory.semantic',
    migrations: `${import.meta.dir}/migrations`,
  });
  const embedCalls: string[][] = [];
  const prompts: string[] = [];
  const store = new SemanticStore(storage);
  const memory = new SemanticMemory({
    ...(busy === undefined ? {} : { activity: { busy } }),
    chat: fakeChat(answers, prompts),
    dream,
    embedding: fakeEmbedding(embedCalls),
    maxDistance: 2,
    maxRecallFacts: 10,
    store,
  });
  await memory.start();
  return { embedCalls, memory, prompts, store };
}

const NEVER_DREAM = { episodes: 1_000, idleSeconds: 86_400, maxDelaySeconds: 604_800 };

const TEA =
  '{"facts": [{"kind": "preference", "text": "Alice prefers jasmine tea.", "confidence": 0.9, "invalidates": []}]}';

/** Waits for the background pass without disposing, so more turns can follow. */
async function quiesce(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await Bun.sleep(2);
}

describe('SemanticMemory dream pacing', () => {
  test('a finished turn does not spend the extraction model on its own', async () => {
    const { memory, prompts, store } = await pacedHarness([TEA, TEA], {
      episodes: 8,
      idleSeconds: 90,
      maxDelaySeconds: 1_800,
    });
    await memory.retain(freshRetainRequest('tea', 'I always drink jasmine tea.'));
    await quiesce();

    // The turn is kept; only deciding what it meant is deferred.
    expect(prompts).toEqual([]);
    expect((await store.pendingBacklog()).count).toBe(1);
    await memory.dispose();
  });

  test('a backlog reaching the threshold starts a pass without waiting for quiet', async () => {
    const { memory, prompts } = await pacedHarness([TEA, TEA, TEA], {
      episodes: 2,
      idleSeconds: 90,
      maxDelaySeconds: 1_800,
    });
    await memory.retain(freshRetainRequest('one', 'I always drink jasmine tea.'));
    await quiesce();
    expect(prompts).toEqual([]);

    await memory.retain(freshRetainRequest('two', 'I also play the cello.'));
    await quiesce();
    expect(prompts.length).toBe(2);
    await memory.dispose();
  });

  test('quiet long enough starts a pass a backlog alone would not', async () => {
    const { memory, prompts } = await pacedHarness([TEA, TEA], {
      episodes: 100,
      idleSeconds: 0.02,
      maxDelaySeconds: 1_800,
    });
    // The first consider only marks when quiet began; the second measures it.
    await memory.retain(freshRetainRequest('one', 'I always drink jasmine tea.'));
    await quiesce();

    await memory.retain(freshRetainRequest('two', 'I also play the cello.'));
    await quiesce();
    expect(prompts.length).toBe(2);
    await memory.dispose();
  });

  test('a busy runtime holds the extraction model back', async () => {
    let busy = true;
    const { memory, prompts } = await pacedHarness(
      [TEA, TEA],
      { episodes: 1, idleSeconds: 0.02, maxDelaySeconds: 1_800 },
      () => busy,
    );
    await memory.retain(freshRetainRequest('one', 'I always drink jasmine tea.'));
    await quiesce();
    // The backlog threshold is met; someone waiting is what stops it.
    expect(prompts).toEqual([]);

    busy = false;
    await memory.retain(freshRetainRequest('two', 'I also play the cello.'));
    await quiesce();
    expect(prompts.length).toBe(2);
    await memory.dispose();
  });

  test('the ceiling overrides a runtime that is never quiet', async () => {
    const { memory, prompts } = await pacedHarness(
      [TEA],
      { episodes: 100, idleSeconds: 90, maxDelaySeconds: 0.01 },
      () => true,
    );
    await memory.retain(freshRetainRequest('one', 'I always drink jasmine tea.'));
    await Bun.sleep(30);
    await memory.retain(freshRetainRequest('two', 'I also play the cello.'));
    await quiesce();

    // Waiting past the ceiling is the one case that outranks someone waiting.
    expect(prompts.length).toBeGreaterThan(0);
    await memory.dispose();
  });
});

/** Two vectors a chosen L2 distance apart, both unit length in the first plane. */
function vectorAtAngle(radians: number): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = Math.cos(radians);
  vector[1] = Math.sin(radians);
  return vector;
}

describe('SemanticMemory consolidation', () => {
  test('folds a restated fact into the first one and keeps it as history', async () => {
    const { store } = await pacedHarness([], NEVER_DREAM);
    const first = await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));
    // ~0.1 apart in L2: a restatement, well inside the merge threshold.
    const second = await seedFact(store, 2, 'Alice plays cello.', vectorAtAngle(0.1));

    const result = await store.consolidateDuplicates(32, 0.25);
    expect(result.merged).toBe(1);

    // The earlier statement survives, because the pair became true when it did.
    const live = await store.liveFacts(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      10,
    );
    expect(live.map((fact) => fact.factId)).toEqual([first]);

    // Two witnesses now support one fact, which is what promotion ranks on.
    const inspected = await store.inspectFacts({
      limit: 10,
      offset: 0,
      scope: { agentId: 'agent-a', principal: ALICE },
      signal: AbortSignal.any([]),
    });
    const survivor = inspected.entries.find((fact) => fact.id === String(first));
    const merged = inspected.entries.find((fact) => fact.id === String(second));
    expect(survivor?.supportCount).toBe(2);
    // Retired rather than deleted, pointing at where its content now lives.
    expect(merged?.invalidatedAt).toBeDefined();
    expect(merged?.invalidatedBy).toBe(String(first));
  });

  test('leaves apart what only looks related', async () => {
    const { store } = await pacedHarness([], NEVER_DREAM);
    await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));
    // ~0.68 apart: related, nowhere near a restatement.
    await seedFact(store, 2, 'Alice plays the violin.', vectorAtAngle(0.7));

    expect((await store.consolidateDuplicates(32, 0.25)).merged).toBe(0);
    const live = await store.liveFacts(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      10,
    );
    expect(live).toHaveLength(2);
  });

  test('a second pass has nothing left to do', async () => {
    const { store } = await pacedHarness([], NEVER_DREAM);
    await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));
    await seedFact(store, 2, 'Alice plays cello.', vectorAtAngle(0.1));

    expect((await store.consolidateDuplicates(32, 0.25)).merged).toBe(1);
    const second = await store.consolidateDuplicates(32, 0.25);
    expect(second.merged).toBe(0);
    expect(second.candidates).toBe(0);
  });

  test('the dream pass consolidates once nobody is waiting', async () => {
    const { memory, store } = await pacedHarness([], {
      episodes: 100,
      idleSeconds: 0.02,
      maxDelaySeconds: 1_800,
    });
    await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));
    await seedFact(store, 2, 'Alice plays cello.', vectorAtAngle(0.1));

    // Two ticks: the first marks when quiet began, the second measures it.
    await memory.retain(freshRetainRequest('one', 'Nothing to remember here.'));
    await quiesce();
    await memory.retain(freshRetainRequest('two', 'Still nothing.'));
    await quiesce();

    const live = await store.liveFacts(
      { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject },
      10,
    );
    expect(live).toHaveLength(1);
    await memory.dispose();
  });
});

describe('SemanticMemory contradiction resolution', () => {
  /** A memory that will review contradictions, driven straight through its store. */
  async function contradictionHarness(answers: readonly string[]): Promise<Harness> {
    const provider = new MemoryExtensionStorageProvider();
    const storage = await provider.forExtension({
      extensionId: 'nox.memory.semantic',
      migrations: `${import.meta.dir}/migrations`,
    });
    const embedCalls: string[][] = [];
    const prompts: string[] = [];
    const store = new SemanticStore(storage);
    const memory = new SemanticMemory({
      chat: fakeChat(answers, prompts),
      contradictionDistance: 0.9,
      dream: { episodes: 100, idleSeconds: 0.02, maxDelaySeconds: 1_800 },
      embedding: fakeEmbedding(embedCalls),
      maxDistance: 2,
      maxRecallFacts: 10,
      mergeDistance: 0.25,
      store,
    });
    await memory.start();
    return { embedCalls, memory, prompts, store };
  }

  const SCOPE = { agentId: 'agent-a', issuer: ALICE.issuer, subject: ALICE.subject };

  test('offers only pairs inside the band, and only once', async () => {
    const { store } = await pacedHarness([], NEVER_DREAM);
    const madrid = await seedFact(store, 1, 'Alice lives in Madrid.', vectorAtAngle(0));
    // ~0.5 apart: same subject, different claim. Above merging, below unrelated.
    const lisbon = await seedFact(store, 2, 'Alice lives in Lisbon.', vectorAtAngle(0.5));
    // ~1.4 apart: a different subject entirely, and never worth a model call.
    await seedFact(store, 3, 'Alice plays the cello.', vectorAtAngle(1.5));

    const query = { limit: 10, maxDistance: 0.9, minDistance: 0.25, scan: 64 };
    const pairs = await store.contradictionCandidates(query);
    expect(pairs).toHaveLength(1);
    // Oldest first, so the model is shown the claim that might have ended.
    expect(pairs[0]?.earlier.factId).toBe(madrid);
    expect(pairs[0]?.later.factId).toBe(lisbon);

    // Recorded whatever the verdict, so the same pair is never paid for twice.
    await store.resolveContradiction(
      { higher: Math.max(madrid, lisbon), lower: Math.min(madrid, lisbon) },
      undefined,
      new Date(),
    );
    expect(await store.contradictionCandidates(query)).toEqual([]);
  });

  test('retires the ended belief and dates it from its successor', async () => {
    const { store } = await pacedHarness([], NEVER_DREAM);
    const madrid = await seedFact(store, 1, 'Alice lives in Madrid.', vectorAtAngle(0));
    const lisbon = await seedFact(store, 2, 'Alice lives in Lisbon.', vectorAtAngle(0.5));
    const [pair] = await store.contradictionCandidates({
      limit: 10,
      maxDistance: 0.9,
      minDistance: 0.25,
      scan: 64,
    });
    if (pair === undefined) throw new Error('Expected a contradiction candidate.');

    await store.resolveContradiction(
      { higher: Math.max(madrid, lisbon), lower: Math.min(madrid, lisbon) },
      {
        factId: madrid,
        supersededBy: lisbon,
        validTo: pair.later.validFrom,
      },
      new Date(),
    );

    expect((await store.liveFacts(SCOPE, 10)).map((fact) => fact.factId)).toEqual([lisbon]);
    const inspected = await store.inspectFacts({
      limit: 10,
      offset: 0,
      scope: { agentId: 'agent-a', principal: ALICE },
      signal: AbortSignal.any([]),
    });
    const retired = inspected.entries.find((fact) => fact.id === String(madrid));
    expect(retired?.invalidatedBy).toBe(String(lisbon));
    // Ended when its successor became true, not when the pass happened to run.
    expect(retired?.validTo).toBe(pair.later.validFrom);
  });

  test('a model that says nothing ended leaves both standing', async () => {
    const { memory, prompts, store } = await contradictionHarness([
      '{"ended": false, "reason": "Both can be true at once."}',
    ]);
    await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));
    await seedFact(store, 2, 'Alice plays the violin.', vectorAtAngle(0.5));

    // Two ticks: the first marks when quiet began, the second measures it.
    await memory.retain(freshRetainRequest('one', 'Nothing to remember.'));
    await quiesce();
    await memory.retain(freshRetainRequest('two', 'Still nothing.'));
    await quiesce();

    expect(prompts.some((prompt) => prompt.includes('Alice plays the violin.'))).toBe(true);
    expect(await store.liveFacts(SCOPE, 10)).toHaveLength(2);
    await memory.dispose();
  });

  test('an unusable answer retires nothing', async () => {
    const { memory, store } = await contradictionHarness(['not json at all']);
    await seedFact(store, 1, 'Alice lives in Madrid.', vectorAtAngle(0));
    await seedFact(store, 2, 'Alice lives in Lisbon.', vectorAtAngle(0.5));

    await memory.retain(freshRetainRequest('one', 'Nothing to remember.'));
    await quiesce();
    await memory.retain(freshRetainRequest('two', 'Still nothing.'));
    await quiesce();

    // Failing closed: a belief is only ever retired on a verdict that parsed.
    expect(await store.liveFacts(SCOPE, 10)).toHaveLength(2);
    await memory.dispose();
  });
});

describe('SemanticMemory search', () => {
  /**
   * A model shown its own retrieval scores starts reasoning about them instead
   * of about the fact, and pays tokens per result to do it. The audit surface
   * keeps them; the agent-facing search does not.
   */
  test('hands the agent the fact, not how the ranking chose it', async () => {
    const { memory, store } = await pacedHarness([], NEVER_DREAM);
    await seedFact(store, 1, 'Alice plays the cello.', vectorAtAngle(0));

    const found = await memory.search({
      limit: 5,
      query: 'Alice plays the cello.',
      scope: { agentId: 'agent-a', principal: ALICE, sessionId: 'session-search' },
      signal: AbortSignal.any([]),
    });

    expect(found).toHaveLength(1);
    const metadata = found[0]?.metadata ?? {};
    expect(Object.keys(metadata)).toEqual(['supportCount']);
    await memory.dispose();
  });
});

describe('SemanticMemory blocks', () => {
  const BLOCK_SCOPE = { agentId: 'agent-a', principal: ALICE, sessionId: 'session-blocks' };

  test('returns only the declared labels that have been written, in the order asked', async () => {
    const { memory } = await pacedHarness([], NEVER_DREAM);
    await memory.blocks.write({
      label: 'human',
      scope: BLOCK_SCOPE,
      signal: AbortSignal.any([]),
      value: 'Alice, works in Madrid.',
    });

    const read = await memory.blocks.read({
      labels: ['persona', 'human'],
      scope: BLOCK_SCOPE,
      signal: AbortSignal.any([]),
    });

    // 'persona' was never written, so it is absent rather than empty: the
    // caller decides what an unfilled block looks like.
    expect(read).toHaveLength(1);
    expect(read[0]?.label).toBe('human');
    expect(read[0]?.value).toBe('Alice, works in Madrid.');
    await memory.dispose();
  });

  test('overwrites in place rather than accumulating', async () => {
    const { memory } = await pacedHarness([], NEVER_DREAM);
    const write = (value: string) =>
      memory.blocks.write({
        label: 'human',
        scope: BLOCK_SCOPE,
        signal: AbortSignal.any([]),
        value,
      });
    await write('Alice, works in Madrid.');
    await write('Alice, works in Lisbon.');

    const read = await memory.blocks.read({
      labels: ['human'],
      scope: BLOCK_SCOPE,
      signal: AbortSignal.any([]),
    });
    expect(read).toHaveLength(1);
    expect(read[0]?.value).toBe('Alice, works in Lisbon.');
    await memory.dispose();
  });

  test('keeps one principal’s blocks out of another’s', async () => {
    const { memory } = await pacedHarness([], NEVER_DREAM);
    await memory.blocks.write({
      label: 'human',
      scope: BLOCK_SCOPE,
      signal: AbortSignal.any([]),
      value: 'Alice, works in Madrid.',
    });

    const bob = await memory.blocks.read({
      labels: ['human'],
      scope: { agentId: 'agent-a', principal: BOB, sessionId: 'session-bob' },
      signal: AbortSignal.any([]),
    });
    expect(bob).toEqual([]);
    await memory.dispose();
  });

  test('refuses a value past the ceiling a system prompt can carry', async () => {
    const { memory } = await pacedHarness([], NEVER_DREAM);
    let refused: unknown;
    try {
      await memory.blocks.write({
        label: 'human',
        scope: BLOCK_SCOPE,
        signal: AbortSignal.any([]),
        value: 'x'.repeat(2_001),
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RangeError);
    expect((refused as RangeError).message).toContain('at most 2000 characters');
    await memory.dispose();
  });
});
