import {
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { gateConfigSchema, reviewerConfigSchema } from './config';
import { ToolGate } from './gate';

import type { ChatProvider, Message } from '../../provider';
import type { ToolEntry } from '../registry';
import type { Tool } from '../tool';
import type { GateConfig } from './config';
import type { GateRequest } from './types';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function tool(name: string): Tool {
  return {
    description: `${name} description`,
    executionType: 'immediate',
    name,
    parameters: z.object({ command: z.string() }),
    prepare: () => ({ run: async () => [], title: name, type: 'immediate' }),
  };
}

function request(overrides: {
  toolName?: string;
  toolSetId?: string;
  params?: unknown;
  sessionId?: string;
} = {}): GateRequest {
  const entry: ToolEntry = {
    exposure: 'eager',
    tool: tool(overrides.toolName ?? 'bash'),
    toolSetId: overrides.toolSetId ?? 'shell',
  };
  const params = overrides.params ?? { command: 'ls' };

  return {
    entry,
    execution: { run: async () => [], title: `Bash — ${JSON.stringify(params)}`, type: 'immediate' },
    params,
    sessionId: overrides.sessionId ?? 'session-1',
  };
}

function config(overrides: Partial<GateConfig> = {}): GateConfig {
  return gateConfigSchema.parse(overrides);
}

function failingProvider(): ChatProvider {
  return {
    getMessageStream: () => {
      throw new Error('provider down');
    },
    getModelConfig: () => undefined,
  } as unknown as ChatProvider;
}

function reviewProvider(answer: string, onRequest?: () => void): ChatProvider {
  return {
    getMessageStream: () => {
      onRequest?.();
      return {
        completed: Promise.resolve([{
          content: [{ text: answer, type: 'text' }],
          createdAt,
          messageId: 'review',
          role: 'assistant',
        } satisfies Message]),
      };
    },
    getModelConfig: () => undefined,
  } as unknown as ChatProvider;
}

const enabledReviewer = (
  overrides: Record<string, unknown> = {},
): GateConfig['reviewer'] => reviewerConfigSchema.parse({
  enabled: true,
  modelId: 'model',
  providerId: 'provider',
  ...overrides,
});

describe('gate rules', () => {
  test('allows anything no rule matches', async () => {
    const gate = new ToolGate({ config: config() });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'default',
      verdict: 'allow',
    });
  });

  test('lets deny win over escalate and allow regardless of order', async () => {
    const gate = new ToolGate({
      config: config({
        rules: [
          { reason: 'allowed', tools: '*', toolSets: '*', verdict: 'allow' },
          { reason: 'blocked', tools: ['bash'], toolSets: '*', verdict: 'deny' },
          { reason: 'asked', tools: '*', toolSets: '*', verdict: 'escalate' },
        ],
      }),
    });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'rules',
      reason: 'blocked',
      verdict: 'deny',
    });
  });

  test('matches on validated params', async () => {
    const gate = new ToolGate({
      config: config({
        rules: [{
          match: { command: '^rm ' },
          reason: 'removes files',
          tools: ['bash'],
          toolSets: '*',
          verdict: 'escalate',
        }],
      }),
    });

    expect(await gate.evaluate(request({ params: { command: 'rm -rf build' } })))
      .toMatchObject({ reason: 'removes files', verdict: 'escalate' });
    expect(await gate.evaluate(request({ params: { command: 'ls' } })))
      .toMatchObject({ verdict: 'allow' });
  });

  test('scopes a rule to a tool set without naming its tools', async () => {
    const gate = new ToolGate({
      config: config({
        rules: [{ reason: 'network', tools: '*', toolSets: ['web'], verdict: 'escalate' }],
      }),
    });

    expect(await gate.evaluate(request({ toolSetId: 'web' })))
      .toMatchObject({ verdict: 'escalate' });
    expect(await gate.evaluate(request({ toolSetId: 'shell' })))
      .toMatchObject({ verdict: 'allow' });
  });

  test('applies the rules a tool set ships with', async () => {
    const gate = new ToolGate({
      config: config(),
      declaredRules: [{ reason: 'shipped', tools: ['bash'], toolSets: '*', verdict: 'escalate' }],
    });

    expect(await gate.evaluate(request())).toMatchObject({
      reason: 'shipped',
      verdict: 'escalate',
    });
  });
});

describe('gate escalation', () => {
  const escalateEverything = (): GateConfig => config({
    rules: [{ reason: 'needs a human', tools: '*', toolSets: '*', verdict: 'escalate' }],
  });

  test('remembers a call approved for the session', async () => {
    const gate = new ToolGate({ config: escalateEverything() });
    const call = request();

    const pending = gate.escalate(call, 'req-1', 'needs a human');
    expect(gate.escalation.resolve('req-1', true, 'session')).toBe(true);
    expect(await pending).toEqual({ resolution: 'approved', scope: 'session' });

    expect(await gate.evaluate(call)).toMatchObject({
      evaluatorId: 'memo',
      verdict: 'allow',
    });
  });

  test('keeps asking for a one-off approval', async () => {
    const gate = new ToolGate({ config: escalateEverything() });
    const call = request();

    const pending = gate.escalate(call, 'req-1', 'needs a human');
    gate.escalation.resolve('req-1', true);
    await pending;

    expect(await gate.evaluate(call)).toMatchObject({ verdict: 'escalate' });
  });

  test('never remembers a refusal', async () => {
    const gate = new ToolGate({ config: escalateEverything() });
    const call = request();

    const pending = gate.escalate(call, 'req-1', 'needs a human');
    gate.escalation.resolve('req-1', false, 'session');
    expect(await pending).toEqual({ resolution: 'denied', scope: 'once' });

    expect(await gate.evaluate(call)).toMatchObject({ verdict: 'escalate' });
  });

  test('keeps memories separate per session and forgets a closed one', async () => {
    const gate = new ToolGate({ config: escalateEverything() });
    const first = request({ sessionId: 'session-1' });

    const pending = gate.escalate(first, 'req-1', 'needs a human');
    gate.escalation.resolve('req-1', true, 'session');
    await pending;

    expect(await gate.evaluate(request({ sessionId: 'session-2' })))
      .toMatchObject({ verdict: 'escalate' });

    gate.forget('session-1');
    expect(await gate.evaluate(first)).toMatchObject({ verdict: 'escalate' });
  });

  test('reports a timeout without blocking forever', async () => {
    const gate = new ToolGate({ config: config({ escalationTimeoutMs: 1 }) });

    expect(await gate.escalate(request(), 'req-1', 'needs a human'))
      .toEqual({ resolution: 'timeout', scope: 'once' });
  });
});

describe('gate reviewer', () => {
  test('stays out of the chain while disabled', () => {
    const gate = new ToolGate({ config: config() });
    expect(gate.evaluatorIds).toEqual(['memo', 'rules']);
  });

  test('refuses to start when enabled without a usable provider', () => {
    expect(() => new ToolGate({ config: config({ reviewer: enabledReviewer() }) }))
      .toThrow('Gate reviewer is enabled but provider "provider" is unavailable.');
  });

  test('escalates what the model objects to', async () => {
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer() }),
      reviewProvider: reviewProvider('{"verdict":"escalate","reason":"deletes the build"}'),
    });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'reviewer',
      reason: 'deletes the build',
      verdict: 'escalate',
    });
  });

  test('reads a verdict out of a fenced answer', async () => {
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer() }),
      reviewProvider: reviewProvider('```json\n{"verdict":"deny","reason":"hostile"}\n```'),
    });

    expect(await gate.evaluate(request())).toMatchObject({ reason: 'hostile', verdict: 'deny' });
  });

  test('cannot approve: an allow answer is unusable, not an approval', async () => {
    const gate = new ToolGate({
      config: config({
        reviewer: enabledReviewer(),
        rules: [{ reason: 'needs a human', tools: '*', toolSets: '*', verdict: 'escalate' }],
      }),
      reviewProvider: reviewProvider('{"verdict":"allow","reason":"looks fine"}'),
    });

    // The rules still decide; the reviewer is never even reached past them.
    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'rules',
      verdict: 'escalate',
    });
  });

  test('falls back to the rules when the model call fails', async () => {
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer() }),
      reviewProvider: failingProvider(),
    });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'default',
      verdict: 'allow',
    });
  });

  test('escalates on failure when configured to', async () => {
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer({ onError: 'escalate' }) }),
      reviewProvider: failingProvider(),
    });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'reviewer',
      verdict: 'escalate',
    });
  });

  test('skips tools outside appliesTo', async () => {
    let calls = 0;
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer({ appliesTo: ['web'] }) }),
      reviewProvider: reviewProvider(
        '{"verdict":"deny","reason":"nope"}',
        () => { calls += 1; },
      ),
    });

    expect(await gate.evaluate(request({ toolSetId: 'shell' })))
      .toMatchObject({ verdict: 'allow' });
    expect(calls).toBe(0);

    expect(await gate.evaluate(request({ toolSetId: 'web' })))
      .toMatchObject({ verdict: 'deny' });
    expect(calls).toBe(1);
  });

  test('reviews an identical call only once', async () => {
    let calls = 0;
    const gate = new ToolGate({
      config: config({ reviewer: enabledReviewer() }),
      reviewProvider: reviewProvider(
        '{"verdict":"escalate","reason":"twice is once"}',
        () => { calls += 1; },
      ),
    });

    await gate.evaluate(request({ params: { command: 'rm -rf build' } }));
    await gate.evaluate(request({ params: { command: 'rm -rf build' } }));
    expect(calls).toBe(1);

    await gate.evaluate(request({ params: { command: 'rm -rf dist' } }));
    expect(calls).toBe(2);
  });

  test('is skipped entirely when a rule already decided', async () => {
    let calls = 0;
    const gate = new ToolGate({
      config: config({
        reviewer: enabledReviewer(),
        rules: [{ reason: 'trusted', tools: ['bash'], toolSets: '*', verdict: 'allow' }],
      }),
      reviewProvider: reviewProvider(
        '{"verdict":"deny","reason":"nope"}',
        () => { calls += 1; },
      ),
    });

    expect(await gate.evaluate(request())).toMatchObject({
      evaluatorId: 'rules',
      verdict: 'allow',
    });
    expect(calls).toBe(0);
  });
});
