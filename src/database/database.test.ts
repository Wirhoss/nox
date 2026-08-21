import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { Database } from './database';
import { decisions, messages, sessions } from './schema';

const directories: string[] = [];
let open: Database | undefined;

function migrationCount(): number {
  const journal: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, 'migrations', 'meta', '_journal.json'), 'utf8'),
  );
  const entries = (journal as { entries?: unknown[] }).entries ?? [];
  return entries.length;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nox-db-'));
  directories.push(directory);
  return join(directory, 'nox.db');
}

async function openDatabase(path = databasePath()): Promise<Database> {
  open = await Database.open({ path });
  return open;
}

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

async function seedSession(database: Database, sessionId: string): Promise<void> {
  const now = Date.now();
  await database.transaction((tx) => {
    tx.insert(sessions).values({ createdAt: now, sessionId, updatedAt: now }).run();
  });
}

afterEach(async () => {
  await open?.close();
  open = undefined;
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

describe('Database.open', () => {
  test('every call returns an independent instance', async () => {
    const path = databasePath();
    const first = await openDatabase(path);
    const second = await Database.open({ path });

    // No process-wide instance: whoever owns the lifecycle owns the one
    // connection, and closing one here must not disturb the other.
    expect(second).not.toBe(first);
    await second.close();

    expect(second.isOpen).toBeFalse();
    expect(first.isOpen).toBeTrue();
  });

  test('enables WAL and foreign keys', async () => {
    const database = await openDatabase();

    const journal = database.db.all<{ journal_mode: string }>('PRAGMA journal_mode');
    const foreignKeys = database.db.all<{ foreign_keys: number }>('PRAGMA foreign_keys');

    expect(journal[0]?.journal_mode.toLowerCase()).toBe('wal');
    expect(foreignKeys[0]?.foreign_keys).toBe(1);
  });

  test('reopening an existing file is idempotent and keeps its rows', async () => {
    const path = databasePath();
    const first = await openDatabase(path);
    await seedSession(first, 'session-a');
    await first.close();

    const second = await openDatabase(path);
    const rows = await second.db.select().from(sessions);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('session-a');
  });

  test('applies the generated migrations and records them', async () => {
    const database = await openDatabase();

    const tables = database.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);

    expect(tables).toContain('decisions');
    expect(tables).toContain('messages');
    expect(tables).toContain('sessions');
    expect(tables).toContain('__drizzle_migrations');
  });

  test('re-running migrations on an existing file is a no-op', async () => {
    const path = databasePath();
    const first = await openDatabase(path);
    const applied = first.db.all<{ hash: string }>('SELECT hash FROM __drizzle_migrations');
    await seedSession(first, 'session-a');
    await first.close();

    const second = await openDatabase(path);
    const reapplied = second.db.all<{ hash: string }>('SELECT hash FROM __drizzle_migrations');

    expect(applied).toHaveLength(migrationCount());
    expect(reapplied).toEqual(applied);
    expect(await second.db.select().from(sessions)).toHaveLength(1);
  });
});

describe('Database writes', () => {
  test('serialises concurrent transactions from multiple agents', async () => {
    const database = await openDatabase();
    await seedSession(database, 'session-a');

    const agents = Array.from({ length: 25 }, (_unused, index) => index);
    await Promise.all(
      agents.map(async (index) =>
        database.transaction((tx) => {
          const [last] = tx
            .select({ seq: messages.seq })
            .from(messages)
            .where(eq(messages.sessionId, 'session-a'))
            .orderBy(messages.seq)
            .all()
            .slice(-1);

          tx.insert(messages)
            .values({
              content: [{ text: `message ${String(index)}`, type: 'text' }],
              createdAt: Date.now(),
              messageId: `message-${String(index)}`,
              role: 'user',
              seq: (last?.seq ?? 0) + 1,
              sessionId: 'session-a',
            })
            .run();
        }),
      ),
    );

    const rows = await database.db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.sessionId, 'session-a'))
      .orderBy(messages.seq);

    // 25 concurrent read-modify-writes must produce a gapless sequence; any
    // interleaving would have tripped the unique index on (session_id, seq).
    expect(rows.map((row) => row.seq)).toEqual(agents.map((index) => index + 1));
  });

  test('rolls a failed transaction back without breaking the queue', async () => {
    const database = await openDatabase();
    await seedSession(database, 'session-a');

    const failure = await rejection(
      database.transaction((tx) => {
        tx.insert(messages)
          .values({
            createdAt: Date.now(),
            messageId: 'doomed',
            role: 'user',
            seq: 1,
            sessionId: 'session-a',
          })
          .run();
        throw new Error('rollback');
      }),
    );
    expect(failure.message).toBe('rollback');

    await database.transaction((tx) => {
      tx.insert(messages)
        .values({
          createdAt: Date.now(),
          messageId: 'survivor',
          role: 'user',
          seq: 1,
          sessionId: 'session-a',
        })
        .run();
    });

    const rows = await database.db.select({ messageId: messages.messageId }).from(messages);
    expect(rows.map((row) => row.messageId)).toEqual(['survivor']);
  });

  test('exclusive() holds the connection across awaits', async () => {
    const database = await openDatabase();
    const events: string[] = [];

    await Promise.all([
      database.exclusive(async () => {
        events.push('a:start');
        await Promise.resolve();
        events.push('a:end');
      }),
      database.exclusive(() => {
        events.push('b');
      }),
    ]);

    expect(events).toEqual(['a:start', 'a:end', 'b']);
  });
});

describe('Database schema', () => {
  test('round-trips every message variant through JSON columns', async () => {
    const database = await openDatabase();
    await seedSession(database, 'session-a');
    const createdAt = Date.now();

    await database.transaction((tx) => {
      tx.insert(messages)
        .values([
          {
            content: [{ text: 'hello', type: 'text' }],
            createdAt,
            messageId: 'user-1',
            role: 'user',
            seq: 1,
            sessionId: 'session-a',
          },
          {
            arguments: { limit: 10, query: 'nox' },
            createdAt,
            messageId: 'call-1',
            name: 'search',
            role: 'toolCall',
            seq: 2,
            sessionId: 'session-a',
            trackId: 'track-1',
          },
          {
            content: [{ source: { type: 'url', url: 'https://x/y.png' }, type: 'image' }],
            createdAt,
            execution: 'immediate',
            isError: false,
            messageId: 'response-1',
            name: 'search',
            role: 'toolResponse',
            seq: 3,
            sessionId: 'session-a',
            trackId: 'track-1',
          },
          {
            anchorMessageId: 'user-1',
            content: [{ text: 'summary', type: 'text' }],
            createdAt,
            messageId: 'folded-1',
            refMessageIds: ['user-1', 'call-1'],
            role: 'folded',
            seq: 4,
            sessionId: 'session-a',
          },
        ])
        .run();
    });

    const rows = await database.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, 'session-a'))
      .orderBy(messages.seq);

    expect(rows.map((row) => row.role)).toEqual(['user', 'toolCall', 'toolResponse', 'folded']);
    expect(rows[0]?.content).toEqual([{ text: 'hello', type: 'text' }]);
    expect(rows[1]?.arguments).toEqual({ limit: 10, query: 'nox' });
    expect(rows[2]?.isError).toBeFalse();
    expect(rows[2]?.execution).toBe('immediate');
    expect(rows[3]?.refMessageIds).toEqual(['user-1', 'call-1']);
  });

  test('cascades transcript and gate audit deletion with its session', async () => {
    const database = await openDatabase();
    await seedSession(database, 'session-a');

    await database.transaction((tx) => {
      tx.insert(messages)
        .values({
          createdAt: Date.now(),
          messageId: 'user-1',
          role: 'user',
          seq: 1,
          sessionId: 'session-a',
        })
        .run();
      tx.insert(decisions)
        .values({
          authority: 'nox.test.tool',
          createdAt: Date.now(),
          decidedBy: 'rules',
          decisionId: 'decision-1',
          params: {},
          principalIssuer: 'test-broker',
          principalSubject: 'alice',
          reason: 'blocked',
          runId: 'run-1',
          sessionId: 'session-a',
          signals: [],
          stage: 'gate',
          title: 'Dangerous action',
          toolName: 'bash',
          toolSetId: 'shell',
          trackId: 'track-1',
          verdict: 'deny',
        })
        .run();
      tx.delete(sessions).where(eq(sessions.sessionId, 'session-a')).run();
    });

    expect(await database.db.select().from(messages)).toHaveLength(0);
    expect(await database.db.select().from(decisions)).toHaveLength(0);
  });

  test('rejects a message whose session does not exist', async () => {
    const database = await openDatabase();

    const failure = await rejection(
      database.transaction((tx) => {
        tx.insert(messages)
          .values({
            createdAt: Date.now(),
            messageId: 'orphan',
            role: 'user',
            seq: 1,
            sessionId: 'missing',
          })
          .run();
      }),
    );
    expect(failure.message).toMatch(/FOREIGN KEY/iu);
  });
});

describe('Database.close', () => {
  test('is idempotent and rejects later use', async () => {
    const database = await openDatabase();

    await database.close();
    await database.close();

    expect(database.isOpen).toBeFalse();
    expect(() => database.db).toThrow('is closed');
    expect((await rejection(database.transaction(() => undefined))).message).toContain('is closed');

    open = undefined;
  });
});
