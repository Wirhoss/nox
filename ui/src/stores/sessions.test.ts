import { afterEach, describe, expect, test } from 'bun:test';

import {
  detail,
  loadDetail,
  requestedSessionId,
  status,
} from './sessions';

import type { SessionSnapshot } from '../utils/types';

const originalFetch = globalThis.fetch;

const snapshotFor = (sessionId: string): SessionSnapshot => ({
  activityCount: 0,
  eventCursor: 0,
  isRunning: false,
  latestRun: null,
  messageEntries: [],
  messages: [],
  recentActivities: [],
  runs: [],
  session: {
    blueprintId: 'blueprint',
    createdAt: 0,
    sessionId,
    updatedAt: 0,
  },
});

describe('session detail loading', (): void => {
  afterEach((): void => {
    globalThis.fetch = originalFetch;
    requestedSessionId.set('');
    detail.set(null);
  });

  test('ignores an older response that arrives after the selected session', async (): Promise<void> => {
    const responses = new Map<string, (response: Response) => void>();
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> =>
      new Promise<Response>((resolve): void => {
        responses.set(String(input), resolve);
      })) as typeof fetch;

    requestedSessionId.set('session-a');
    const firstRequest = loadDetail('session-a');
    requestedSessionId.set('session-b');
    const secondRequest = loadDetail('session-b');

    responses.get('/api/v1/sessions/session-b?activityLimit=500')?.(
      Response.json(snapshotFor('session-b')),
    );
    await secondRequest;
    expect(detail.get()?.session.sessionId).toBe('session-b');

    responses.get('/api/v1/sessions/session-a?activityLimit=500')?.(
      Response.json(snapshotFor('session-a')),
    );
    await firstRequest;

    expect(detail.get()?.session.sessionId).toBe('session-b');
    expect(status.get().detailLoading).toBeFalse();
  });
});
