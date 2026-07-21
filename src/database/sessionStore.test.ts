import { describe, expect, test } from 'bun:test';

import { closeDatabase, openDatabase } from './database';
import { SessionStore } from './sessionStore';

import type { Message } from '../provider';
import type { NoxDatabase } from './database';

function setup(): { database: NoxDatabase; store: SessionStore } {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  store.insertSession({ sessionId: 's1', blueprintId: 'b1', systemPrompt: 'sys' });
  return { database, store };
}

describe('SessionStore', () => {

  test('persists the latest run usage and reconstructable activity', () => {
    const { database, store } = setup();
    const startedAt = '2026-07-20T12:00:00.000Z';
    store.recordEvent('s1', { type: 'runStarted', runId: 'r1', modelId: 'model-1', startedAt });
    store.recordEvent('s1', {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    store.recordEvent('s1', {
      type: 'runCompleted',
      runId: 'r1',
      status: 'completed',
      durationMs: 1250,
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 5 },
    });

    expect(store.getLatestRun('s1')).toMatchObject({
      runId: 'r1',
      modelId: 'model-1',
      status: 'completed',
      startedAt: new Date(startedAt),
      durationMs: 1250,
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 5 },
    });
    const activities = store.getRecentActivities('s1');
    expect(store.getActivityCount('s1')).toBe(3);
    expect(activities.map((activity) => activity.event.type)).toEqual([
      'runStarted',
      'message',
      'runCompleted',
    ]);
    expect(activities.every((activity) => activity.receivedAt instanceof Date)).toBe(true);

    closeDatabase(database);
  });

  test('does not persist streaming reasoning or text fragments as activity', () => {
    const { database, store } = setup();
    store.recordEvent('s1', { type: 'assistantReasoningFragment', text: 'thinking' });
    store.recordEvent('s1', { type: 'assistantTextFragment', text: 'partial' });

    expect(store.getRecentActivities('s1')).toEqual([]);
    expect(store.getActivityCount('s1')).toBe(0);

    closeDatabase(database);
  });

  test('lists runs newest first and filters by status and blueprint', () => {
    const { database, store } = setup();
    store.insertSession({ sessionId: 's2', blueprintId: 'b2', systemPrompt: 'sys' });
    store.recordEvent('s1', { type: 'runStarted', runId: 'r1', modelId: 'model-1', startedAt: '2026-07-20T10:00:00.000Z' });
    store.recordEvent('s1', {
      type: 'runCompleted',
      runId: 'r1',
      status: 'completed',
      durationMs: 900,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
    });
    store.recordEvent('s2', { type: 'runStarted', runId: 'r2', modelId: 'model-2', startedAt: '2026-07-20T11:00:00.000Z' });

    expect(store.listRuns().map((run) => run.runId)).toEqual(['r2', 'r1']);
    expect(store.listRuns({ status: 'running' })).toMatchObject([{
      blueprintId: 'b2',
      runId: 'r2',
      sessionId: 's2',
      status: 'running',
    }]);
    expect(store.listRuns({ blueprintId: 'b1' })).toMatchObject([{
      blueprintId: 'b1',
      runId: 'r1',
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
    }]);
    expect(store.listRuns({ sessionId: 's2' }).map((run) => run.runId)).toEqual(['r2']);

    expect(store.listSessionsWithStats()).toMatchObject([
      {
        sessionId: 's1',
        runCount: 1,
        latestRun: { runId: 'r1', status: 'completed' },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
      },
      {
        sessionId: 's2',
        runCount: 1,
        latestRun: { runId: 'r2', status: 'running' },
      },
    ]);

    closeDatabase(database);
  });

  test('execution round-trips through payload and is queryable in SQL', () => {
    const { database, store } = setup();
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'reasoning', content: [{ type: 'text', text: 'thinking' }] },
      { role: 'toolResponse', name: 'job', trackId: 't1', execution: 'deferredAck', response: [{ type: 'text', text: 'started' }] },
      { role: 'toolResponse', name: 'job', trackId: 't1', execution: 'deferredResult', response: [{ type: 'text', text: 'finished' }] },
    ];
    messages.forEach((message, position) => store.saveMessage('s1', position, message));

    expect(store.getMessages('s1')).toEqual(messages);
    expect(store.getMessageEntries('s1').map((entry) => ({
      message: entry.message,
      position: entry.position,
      timestamped: entry.createdAt instanceof Date,
    }))).toEqual(messages.map((message, position) => ({ message, position, timestamped: true })));

    const rows = database.$client
      .query('SELECT execution FROM message ORDER BY position')
      .all() as Array<{ execution: string | null }>;
    expect(rows.map((row) => row.execution)).toEqual([null, null, 'deferredAck', 'deferredResult']);

    closeDatabase(database);
  });

  test('deleteSession removes the session and its messages', () => {
    const { database, store } = setup();
    store.saveMessage('s1', 0, { role: 'user', content: [{ type: 'text', text: 'hola' }] });
    store.saveMessage('s1', 1, { role: 'reasoning', content: [{ type: 'text', text: 'thinking' }] });
    store.recordEvent('s1', { type: 'runStarted', runId: 'r1', modelId: 'model-1', startedAt: new Date().toISOString() });

    expect(store.deleteSession('s1')).toBe(true);
    expect(store.getSession('s1')).toBeNull();
    expect(store.getMessages('s1')).toEqual([]);
    expect(store.getLatestRun('s1')).toBeNull();
    expect(store.getRecentActivities('s1')).toEqual([]);
    expect(store.deleteSession('s1')).toBe(false);

    closeDatabase(database);
  });

  test('legacy toolResponse rows without execution are read back as immediate', () => {
    const { database, store } = setup();
    const legacyPayload = JSON.stringify({
      role: 'toolResponse',
      name: 'weather',
      trackId: 't1',
      response: [{ type: 'text', text: 'Sunny' }],
    });
    database.$client.run(
      'INSERT INTO message (sessionId, position, role, payload) VALUES (?, ?, ?, ?)',
      ['s1', 0, 'toolResponse', legacyPayload],
    );

    const [message] = store.getMessages('s1');
    expect(message?.role === 'toolResponse' && message.execution).toBe('immediate');

    closeDatabase(database);
  });
});
