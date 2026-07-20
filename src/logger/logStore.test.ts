import { describe, expect, test } from 'bun:test';

import { StructuredLogStore } from './logStore';

describe('StructuredLogStore', () => {
  test('captures structured records newest first and strips Pino fields', () => {
    const store = new StructuredLogStore();
    store.ingest({ level: 30, time: 1_753_011_200_000, module: 'server', msg: 'Listening', pid: 12, port: 3000 });
    store.ingest({ level: 40, time: 1_753_011_201_000, module: 'provider', msg: 'Provider unavailable', providerId: 'local' });

    expect(store.list()).toMatchObject({
      dropped: 0,
      modules: ['provider', 'server'],
      total: 2,
      items: [
        { id: 2, level: 'warn', module: 'provider', message: 'Provider unavailable', context: { providerId: 'local' } },
        { id: 1, level: 'info', module: 'server', message: 'Listening', context: { port: 3000 } },
      ],
    });
  });

  test('filters records and bounds memory', () => {
    const store = new StructuredLogStore(2);
    store.ingest({ level: 30, module: 'server', msg: 'one' });
    store.ingest({ level: 50, module: 'gateway', msg: 'Request failed', sessionId: 's1' });
    store.ingest({ level: 40, module: 'gateway', msg: 'Unknown action' });

    expect(store.list()).toMatchObject({ dropped: 1, total: 2 });
    expect(store.list({ module: 'gateway', search: 's1' }).items).toMatchObject([
      { level: 'error', message: 'Request failed' },
    ]);
    expect(store.list({ level: 'warn' }).items).toMatchObject([
      { message: 'Unknown action' },
    ]);
  });

  test('accepts newline-delimited Pino output', async () => {
    const store = new StructuredLogStore();
    store.write('{"level":30,"module":"agent","msg":"ready"}\n');

    expect(store.list().items).toMatchObject([{ level: 'info', module: 'agent', message: 'ready' }]);
  });
});
