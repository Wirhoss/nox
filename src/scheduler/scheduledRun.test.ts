import { describe, expect, test } from 'bun:test';

import { ScheduledRunRelay } from './scheduledRun';

import type { ScheduledRunHost, ScheduledRunRequest } from '@nox/extension-api';

function request(signal: AbortSignal): ScheduledRunRequest {
  return {
    agentId: 'agent-a',
    causeId: 'run-1',
    name: 'Morning task',
    prompt: 'wake up',
    sessionId: 'fresh-session-a',
    signal,
  };
}

function host(received: ScheduledRunRequest[] = []): ScheduledRunHost {
  return {
    agentIds: () => Promise.resolve(['agent-a']),
    canDeliverTo: () => Promise.resolve(true),
    deliveryBrokerIds: () => Promise.resolve(['discord']),
    deliveryOrigin: () => Promise.resolve(undefined),
    runScheduledAgent: (input) => {
      received.push(input);
      const now = new Date();
      return Promise.resolve({
        completedAt: now,
        content: [{ text: 'done', type: 'text' }],
        runId: 'agent-run-1',
        sessionId: input.sessionId,
        startedAt: now,
        status: 'completed',
      });
    },
  };
}

describe('ScheduledRunRelay', () => {
  test('holds execution and agent discovery until the runtime host connects', async () => {
    const relay = new ScheduledRunRelay();
    const received: ScheduledRunRequest[] = [];
    const signal = new AbortController().signal;
    const execution = relay.runScheduledAgent(request(signal));
    const agents = relay.agentIds(signal);

    expect(received).toHaveLength(0);
    relay.connect(host(received));
    expect(await agents).toEqual(['agent-a']);
    expect((await execution).content).toEqual([{ text: 'done', type: 'text' }]);
    expect(received).toHaveLength(1);
  });

  test('an abort releases a submission waiting during startup', () => {
    const relay = new ScheduledRunRelay();
    const controller = new AbortController();
    const pending = relay.runScheduledAgent(request(controller.signal));

    controller.abort(new Error('scheduler stopped'));

    expect(pending).rejects.toThrow('scheduler stopped');
  });

  test('refuses a second host and every call after disposal', () => {
    const relay = new ScheduledRunRelay();
    const runtime = host();
    relay.connect(runtime);
    expect(() => {
      relay.connect(runtime);
    }).toThrow('already connected');

    relay.dispose();
    expect(relay.runScheduledAgent(request(new AbortController().signal))).rejects.toThrow(
      'no longer available',
    );
  });
});
