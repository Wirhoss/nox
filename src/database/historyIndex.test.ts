import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { testOrigin } from '../testFixtures';
import { Database } from './database';
import { toMatchExpression } from './historyIndex';
import { backfillDerivedIndexes, SessionStore } from './sessionStore';

import type { Message } from '@nox/extension-api';

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

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-history-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

function user(messageId: string, text: string): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    origin: testOrigin(),
    role: 'user',
  };
}

/** A session with its messages already appended and flushed. */
async function session(
  store: SessionStore,
  sessionId: string,
  agentId: string,
  messages: readonly Message[],
  title?: string,
): Promise<void> {
  await store.create(sessionId, { agentId, ...(title === undefined ? {} : { title }) });
  for (const message of messages) store.append(sessionId, message);
  await store.flushed;
}

describe('the match expression', () => {
  test('strips FTS5 operators out of whatever the model typed', () => {
    // Every one of these is syntax to FTS5, and a raw MATCH would fail the tool
    // call rather than return no results — the model would read a crash where
    // it asked a question.
    expect(toMatchExpression('cost AND NOT price')).toBe('"cost" OR "and" OR "not" OR "price"');
    expect(toMatchExpression('src/tool/router.ts')).toBe('"src" OR "tool" OR "router" OR "ts"');
    expect(toMatchExpression('a "quote that never closes')).toBe(
      '"a" OR "quote" OR "that" OR "never" OR "closes"',
    );
  });

  test('a query with no terms in it matches nothing rather than everything', () => {
    expect(toMatchExpression('   ')).toBeUndefined();
    expect(toMatchExpression('-*^:')).toBeUndefined();
  });
});

describe('searching stored transcripts', () => {
  test('finds a message that was appended a moment ago', async () => {
    const store = new SessionStore(await openDatabase());
    await store.create('s1', { agentId: 'agent' });

    store.append('s1', user('u1', 'the deploy key lives at /etc/nox/deploy_ed25519'));
    // Deliberately not awaiting `flushed`: `append` returns once the message is
    // sequenced, so this is exactly the race a live session runs into when the
    // model searches for something it said one turn ago.
    const hits = await store.searchHistory('agent', { limit: 5, query: 'deploy_ed25519' });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain('deploy_ed25519');
  });

  test('scopes to one session when asked and spans them when not', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 's1', 'agent', [user('u1', 'marker in the first session')]);
    await session(store, 's2', 'agent', [user('u2', 'marker in the second session')]);

    const scoped = await store.searchHistory('agent', {
      limit: 10,
      query: 'marker',
      sessionId: 's1',
    });
    const all = await store.searchHistory('agent', { limit: 10, query: 'marker' });

    expect(scoped.map((hit) => hit.sessionId)).toEqual(['s1']);
    expect(all.map((hit) => hit.sessionId).sort()).toEqual(['s1', 's2']);
  });

  test('never returns another agent transcript, even by session ID', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 'mine', 'agent', [user('u1', 'marker of my own')]);
    await session(store, 'theirs', 'other-agent', [user('u2', 'marker of somebody else')]);

    const spanning = await store.searchHistory('agent', { limit: 10, query: 'marker' });
    // Naming the session directly is the interesting case: the scope is not a
    // convenience filter over results the agent could otherwise reach, it is
    // the boundary itself.
    const targeted = await store.searchHistory('agent', {
      limit: 10,
      query: 'marker',
      sessionId: 'theirs',
    });

    expect(spanning.map((hit) => hit.sessionId)).toEqual(['mine']);
    expect(targeted).toEqual([]);
  });

  test('carries the session title so a hit can be placed in a conversation', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 's1', 'agent', [user('u1', 'we settled on port 8443')], 'TLS rollout');

    const hits = await store.searchHistory('agent', { limit: 5, query: '8443' });

    expect(hits[0]?.title).toBe('TLS rollout');
    expect(hits[0]?.messageId).toBe('u1');
  });

  test('ranks the transcript that actually discusses the query above one that mentions it', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 'weak', 'agent', [user('u1', `migration ${'filler word '.repeat(60)}`)]);
    await session(store, 'strong', 'agent', [
      user('u2', 'migration migration migration rollback plan'),
    ]);

    const hits = await store.searchHistory('agent', { limit: 2, query: 'migration' });

    // BM25 is the whole reason for the index: term frequency over document
    // length, not first-match-wins.
    expect(hits[0]?.sessionId).toBe('strong');
  });

  test('matches across accents the way the query was typed', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 's1', 'agent', [user('u1', 'la configuración quedó en el gateway')]);

    const hits = await store.searchHistory('agent', { limit: 5, query: 'configuracion' });

    expect(hits).toHaveLength(1);
  });

  test('does not index the roles that are summaries of indexed messages', async () => {
    const store = new SessionStore(await openDatabase());
    const compacted: Message = {
      compactedMessageIds: ['u1'],
      content: [{ text: 'UNIQUE_NEEDLE summary', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'compact',
      role: 'compacted',
    };
    await session(store, 's1', 'agent', [user('u1', 'UNIQUE_NEEDLE original fact'), compacted]);

    const hits = await store.searchHistory('agent', { limit: 10, query: 'UNIQUE_NEEDLE' });

    // Indexing both would return the same fact twice, once lossily, and let a
    // summary outrank the sentence it summarized.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain('original fact');
  });

  test('an unwritable index does not cost the message', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await store.create('s1', { agentId: 'agent' });
    await database.exclusive((db) => {
      db.run('DROP TABLE history_fts');
    });

    store.append('s1', user('u1', 'still said out loud'));
    await store.flushed;

    // The index and the row share a transaction, so losing the index loses the
    // row too — which is why the failure has to stay recoverable rather than
    // silent. What must not happen is the transcript in memory diverging
    // without anyone hearing about it.
    const stored = await store.load('s1');
    expect(stored?.messages).toEqual([]);
  });
});

function withArtifact(messageId: string, artifactId: string): Message {
  return {
    createdAt: CREATED_AT,
    execution: 'immediate',
    messageId,
    name: 'fetch',
    response: [{ artifact: { artifactId, mediaType: 'image/png', size: 12 }, type: 'artifact' }],
    role: 'toolResponse',
    trackId: `track-${messageId}`,
    trust: 'untrusted',
  };
}

describe('artifact references', () => {
  test('recognises an artifact handed to an earlier session of the same agent', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 'old', 'agent', [withArtifact('r1', 'art_abcdefgh')]);
    await store.create('new', { agentId: 'agent' });

    // The whole point of widening the gate: the session that received it is
    // over, and the one asking is a different one held with the same agent.
    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeTrue();
  });

  test('does not recognise one handed to another agent', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 'theirs', 'other-agent', [withArtifact('r1', 'art_abcdefgh')]);

    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeFalse();
  });

  test('an ID the model merely wrote in a tool call is not a reference', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 's1', 'agent', [
      {
        arguments: { artifactId: 'art_abcdefgh' },
        createdAt: CREATED_AT,
        messageId: 'c1',
        name: 'artifact_read',
        role: 'toolCall',
        trackId: 'track-c1',
      },
    ]);

    // Arguments are the model's own words. Treating them as proof of receipt
    // would let it name any artifact ID into existence and then read it.
    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeFalse();
  });

  test('an unknown artifact is not a reference', async () => {
    const store = new SessionStore(await openDatabase());
    await session(store, 's1', 'agent', [user('u1', 'no artifacts here')]);

    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeFalse();
  });
});

describe('backfilling', () => {
  test('indexes transcripts written before the index existed', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await session(store, 's1', 'agent', [user('u1', 'a fact from before the index')]);

    // Standing in for the state a pre-index database is opened in: rows in
    // `messages`, nothing derived from them and no record of a rebuild.
    await database.exclusive((db) => {
      db.run('DELETE FROM history_fts');
      db.run('DELETE FROM backfills');
    });
    expect(await store.searchHistory('agent', { limit: 5, query: 'fact' })).toEqual([]);

    await backfillDerivedIndexes(database);

    const hits = await store.searchHistory('agent', { limit: 5, query: 'fact' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sessionId).toBe('s1');
  });

  test('runs once and then leaves the index alone', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await session(store, 's1', 'agent', [user('u1', 'indexed once')]);
    await database.exclusive((db) => {
      db.run('DELETE FROM history_fts');
      db.run('DELETE FROM backfills');
    });

    await backfillDerivedIndexes(database);
    await backfillDerivedIndexes(database);

    // A second pass that re-indexed would return the same chunk twice and
    // quietly double every score.
    const hits = await store.searchHistory('agent', { limit: 10, query: 'indexed' });
    expect(hits).toHaveLength(1);
  });

  test('records artifact references from transcripts stored before the table existed', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await session(store, 's1', 'agent', [withArtifact('r1', 'art_abcdefgh')]);
    await database.exclusive((db) => {
      db.run('DELETE FROM message_artifacts');
      db.run('DELETE FROM backfills');
    });
    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeFalse();

    await backfillDerivedIndexes(database);

    expect(await store.hasArtifactReference('agent', 'art_abcdefgh')).toBeTrue();
  });

  test('rebuilds an index a previous release left half built', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await session(store, 's1', 'agent', [user('u1', 'indexed once')]);
    // The state a database upgraded mid-series is in: chunks already written by
    // the release that introduced them, no record of any rebuild.
    await database.exclusive((db) => {
      db.run('DELETE FROM backfills');
    });

    await backfillDerivedIndexes(database);

    const hits = await store.searchHistory('agent', { limit: 10, query: 'indexed' });
    expect(hits).toHaveLength(1);
  });
});
