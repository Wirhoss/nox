import { describe, expect, test } from 'bun:test';

import { closeDatabase, openDatabase } from './database';
import { SessionStore } from './sessionStore';

import type { Message } from '../provider';

function setup() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  store.insertSession({ sessionId: 's1', blueprintId: 'b1', systemPrompt: 'sys' });
  return { database, store };
}

describe('SessionStore', () => {
  test('execution round-trips through payload and is queryable in SQL', () => {
    const { database, store } = setup();
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'toolResponse', name: 'job', trackId: 't1', execution: 'deferredAck', response: [{ type: 'text', text: 'started' }] },
      { role: 'toolResponse', name: 'job', trackId: 't1', execution: 'deferredResult', response: [{ type: 'text', text: 'finished' }] },
    ];
    messages.forEach((message, position) => store.saveMessage('s1', position, message));

    expect(store.getMessages('s1')).toEqual(messages);

    const rows = database.$client
      .query('SELECT execution FROM message ORDER BY position')
      .all() as Array<{ execution: string | null }>;
    expect(rows.map((row) => row.execution)).toEqual([null, 'deferredAck', 'deferredResult']);

    closeDatabase(database);
  });

  test('deleteSession removes the session and its messages', () => {
    const { database, store } = setup();
    store.saveMessage('s1', 0, { role: 'user', content: [{ type: 'text', text: 'hola' }] });

    expect(store.deleteSession('s1')).toBe(true);
    expect(store.getSession('s1')).toBeNull();
    expect(store.getMessages('s1')).toEqual([]);
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
