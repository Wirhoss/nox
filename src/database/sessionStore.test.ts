import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { type Message, messageToString } from '../agent/context/message';
import { messageAuthority } from '../auth/principal';
import { TEST_AUTHORITY, testOrigin } from '../testFixtures';
import { Database } from './database';
import { messages } from './schema';
import { SessionStore } from './sessionStore';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

const directories: string[] = [];
const opened: Database[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    // Windows keeps the SQLite file handle briefly after close(); the temp
    // directory is disposable either way, so a failed unlink is not a failure.
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

/** Resolves with the error a promise rejected with, or throws if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError(`Expected an Error, got ${typeof error}.`, { cause: error });
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-store-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

/** One of every role, which is what a replayed transcript has to survive. */
function everyRole(): Message[] {
  return [
    {
      content: [{ text: 'hello', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'u1',
      origin: testOrigin(),
      role: 'user',
    },
    {
      content: [{ text: 'thinking', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'r1',
      role: 'reasoning',
    },
    {
      content: [{ text: 'replying', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'a1',
      role: 'assistant',
    },
    {
      arguments: { path: '/tmp/file', recursive: true },
      createdAt: CREATED_AT,
      messageId: 'c1',
      name: 'read',
      role: 'toolCall',
      trackId: 'track-1',
    },
    {
      createdAt: CREATED_AT,
      execution: 'immediate',
      isError: true,
      messageId: 'p1',
      name: 'read',
      response: [{ text: 'no such file', type: 'text' }],
      role: 'toolResponse',
      trackId: 'track-1',
      trust: 'untrusted',
    },
    {
      anchorMessageId: 'a1',
      content: [{ text: 'folded traffic', type: 'text' }],
      createdAt: CREATED_AT,
      foldedMessageIds: ['c1', 'p1'],
      messageId: 'f1',
      role: 'folded',
    },
    {
      compactedMessageIds: ['u1', 'r1'],
      content: [{ text: 'the handoff', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'k1',
      role: 'compacted',
    },
  ];
}

describe('SessionStore', () => {
  test('every role survives a round trip, byte for byte', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('session-1');

    const original = everyRole();
    for (const message of original) store.append('session-1', message);
    await store.flushed;

    const loaded = await store.load('session-1');
    expect(loaded?.messages.map(messageToString)).toEqual(original.map(messageToString));
  });

  test('a tool response keeps its trust across a reload, and a row without one fences', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await store.create('session-1');

    store.append('session-1', {
      createdAt: CREATED_AT,
      execution: 'immediate',
      messageId: 'catalog',
      name: 'search_tool',
      response: [{ text: 'the tool catalog', type: 'text' }],
      role: 'toolResponse',
      trackId: 'track-1',
      trust: 'trusted',
    });
    await store.flushed;

    // A row written before this column existed. Its content is real tool output
    // that nothing can vouch for any more, so the reading that fences it is the
    // only safe one — `trusted` here would un-fence every historical result.
    await database.exclusive((db) => {
      db.insert(messages)
        .values({
          content: [{ text: 'a page from 2024', type: 'text' }],
          createdAt: CREATED_AT.getTime(),
          execution: 'immediate',
          messageId: 'legacy',
          name: 'fetch',
          role: 'toolResponse',
          seq: 1,
          sessionId: 'session-1',
          trackId: 'track-2',
        })
        .run();
    });

    const loaded = await store.load('session-1');
    const [catalog, legacy] = loaded?.messages ?? [];

    expect(catalog?.role === 'toolResponse' ? catalog.trust : undefined).toBe('trusted');
    expect(legacy?.role === 'toolResponse' ? legacy.trust : undefined).toBe('untrusted');
  });

  test('messages come back in append order regardless of write timing', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('session-1');

    for (let index = 0; index < 25; index++) {
      store.append('session-1', {
        content: [{ text: `message ${String(index)}`, type: 'text' }],
        createdAt: CREATED_AT,
        messageId: `m${String(index)}`,
        origin: testOrigin(),
        role: 'user',
      });
    }
    await store.flushed;

    const loaded = await store.load('session-1');
    expect(loaded?.messages.map((message) => message.messageId)).toEqual(
      Array.from({ length: 25 }, (_value, index) => `m${String(index)}`),
    );
  });

  test('a reopened session keeps sequencing where it left off', async () => {
    const database = await openDatabase();
    const first = new SessionStore(database);
    await first.create('session-1');
    first.append('session-1', {
      content: [{ text: 'before', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'before',
      origin: testOrigin(),
      role: 'user',
    });
    await first.flushed;

    const second = new SessionStore(database);
    await second.load('session-1');
    second.append('session-1', {
      content: [{ text: 'after', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'after',
      origin: testOrigin(),
      role: 'user',
    });
    await second.flushed;

    const loaded = await second.load('session-1');
    expect(loaded?.messages.map((message) => message.messageId)).toEqual(['before', 'after']);
  });

  test('an unknown session loads as undefined', async () => {
    const store = new SessionStore(await openDatabase());

    expect(await store.load('never-created')).toBeUndefined();
  });

  test('session metadata and title round trip', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('session-1', { metadata: { blueprint: 'coder' }, title: 'First run' });

    const loaded = await store.load('session-1');
    expect(loaded?.session).toMatchObject({ metadata: { blueprint: 'coder' }, title: 'First run' });
  });

  test('a row that cannot become a message refuses to open the session', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await store.create('session-1');

    // A tool call with no name: nothing downstream could replay this.
    await database.exclusive((db) => {
      db.insert(messages)
        .values({
          createdAt: CREATED_AT.getTime(),
          messageId: 'broken',
          role: 'toolCall',
          seq: 0,
          sessionId: 'session-1',
          trackId: 'track-1',
        })
        .run();
    });

    const failure = await rejection(store.load('session-1'));
    expect(failure.message).toContain(
      'Message broken in session session-1 is not a valid toolCall',
    );
  });

  test('a failed write is logged and reported, and the session carries on', async () => {
    const database = await openDatabase();
    const failures: [Error, string][] = [];
    const store = new SessionStore(database, {
      onError: (error, sessionId) => failures.push([error, sessionId]),
    });
    await store.create('session-1');
    await database.close();

    store.append('session-1', {
      content: [{ text: 'lost', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'lost',
      origin: testOrigin(),
      role: 'user',
    });
    await store.flushed;

    expect(failures).toHaveLength(1);
    expect(failures[0]?.[1]).toBe('session-1');
    expect(failures[0]?.[0].message).toContain('closed');
  });

  test('closes unresolved escalations when a session is resumed after restart', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('session-1');
    store.recordGateDecision({
      authority: TEST_AUTHORITY,
      createdAt: CREATED_AT,
      decidedBy: 'shared-conversation',
      decisionId: 'decision-1',
      params: {},
      reason: 'needs owner approval',
      runAuthority: messageAuthority(testOrigin(), 'u1'),
      runId: 'run-1',
      sessionId: 'session-1',
      signals: [],
      title: 'Do work',
      toolName: 'echo',
      toolSetId: 'direct',
      trackId: 'track-1',
      verdict: 'escalate',
    });
    await store.flushed;

    const resolvedAt = new Date('2025-01-02T00:00:00.000Z');
    await store.abortUnresolvedGateDecisions('session-1', resolvedAt);

    expect(await store.loadDecisions('session-1')).toMatchObject([
      { resolution: 'aborted', resolvedAt },
    ]);
  });

  test('flushed waits for queued writes and stays resolved when the queue is empty', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('session-1');

    store.append('session-1', {
      content: [{ text: 'queued', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'queued',
      origin: testOrigin(),
      role: 'user',
    });
    await store.flushed;
    await store.flushed;

    const loaded = await store.load('session-1');
    expect(loaded?.messages).toHaveLength(1);
  });
});
