import { describe, expect, test } from 'bun:test';

import { SessionGate } from './gate';

import type { GatePolicyInput } from './config';
import type { GateRequest, PendingPermission } from './types';

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    params: { command: 'ls' },
    sessionId: 'session-1',
    title: 'Run command',
    toolName: 'bash',
    toolSetId: 'shell',
    trackId: 'track-1',
    ...overrides,
  };
}

function policy(overrides: Partial<GatePolicyInput> = {}): GatePolicyInput {
  return { defaultVerdict: 'allow', ...overrides };
}

async function requestApproval(gate: SessionGate, call: GateRequest): Promise<PendingPermission> {
  const decision = await gate.evaluate(call);
  if (decision.verdict !== 'escalate') throw new Error('Expected an escalation.');
  return gate.requestPermission(call, decision);
}

describe('SessionGate rules', () => {
  test('uses an explicit default when no rule matches', async () => {
    const gate = new SessionGate('session-1', policy({ defaultVerdict: 'escalate' }));

    expect(await gate.evaluate(request())).toMatchObject({
      decidedBy: 'default',
      reason: 'No gate rule or evaluator decided.',
      verdict: 'escalate',
    });
  });

  test('lets deny beat escalate and allow regardless of declaration order', async () => {
    const gate = new SessionGate(
      'session-1',
      policy({
        rules: [
          { reason: 'trusted', tools: '*', verdict: 'allow' },
          { reason: 'ask first', tools: ['bash'], verdict: 'escalate' },
          { reason: 'blocked', tools: ['bash'], verdict: 'deny' },
        ],
      }),
    );

    expect(await gate.evaluate(request())).toMatchObject({
      decidedBy: 'rules',
      reason: 'blocked',
      verdict: 'deny',
    });
  });

  test('matches tool set, tool and validated parameter patterns together', async () => {
    const gate = new SessionGate(
      'session-1',
      policy({
        rules: [
          {
            match: { command: '^rm\\s' },
            reason: 'removes files',
            tools: ['bash'],
            toolSets: ['shell'],
            verdict: 'escalate',
          },
        ],
      }),
    );

    expect(await gate.evaluate(request({ params: { command: 'rm -rf build' } }))).toMatchObject({
      reason: 'removes files',
      verdict: 'escalate',
    });
    expect(await gate.evaluate(request())).toMatchObject({ verdict: 'allow' });
  });

  test('rejects invalid regular expressions when policy is loaded', () => {
    expect(
      () =>
        new SessionGate(
          'session-1',
          policy({
            rules: [
              {
                match: { command: '[' },
                reason: 'broken',
                tools: '*',
                verdict: 'deny',
              },
            ],
          }),
        ),
    ).toThrow('Invalid regular expression');
  });
});

describe('SessionGate risk evaluation', () => {
  test('escalates declared destructive and out-of-root effects with audit signals', async () => {
    const gate = new SessionGate(
      'session-1',
      policy({
        defaultVerdict: 'allow',
        heuristics: { allowedRoots: ['/workspace'] },
      }),
    );

    const decision = await gate.evaluate(
      request({
        risk: {
          effects: ['delete'],
          resources: [{ kind: 'file', value: '/etc/important.conf' }],
          reversible: false,
        },
      }),
    );

    expect(decision).toMatchObject({ decidedBy: 'heuristics', verdict: 'escalate' });
    const codes = decision.signals.map(({ code }) => code);
    expect(codes).toContain('delete');
    expect(codes).toContain('outside_allowed_root');
    expect(codes).toContain('irreversible');
  });

  test('flags sensitive reads and unknown network destinations', async () => {
    const gate = new SessionGate('session-1', policy());

    const decision = await gate.evaluate(
      request({
        risk: {
          effects: ['read', 'network'],
          resources: [
            { kind: 'file', value: '/workspace/.env' },
            { kind: 'url', value: 'https://unknown.example/upload' },
          ],
        },
      }),
    );

    expect(decision.verdict).toBe('escalate');
    const codes = decision.signals.map(({ code }) => code);
    expect(codes).toContain('sensitive_path');
    expect(codes).toContain('unknown_domain');
  });

  test('an explicit allow rule is authoritative over advisory heuristics', async () => {
    const gate = new SessionGate(
      'session-1',
      policy({
        rules: [{ reason: 'trusted cleanup', tools: ['bash'], verdict: 'allow' }],
      }),
    );

    expect(
      await gate.evaluate(request({ risk: { effects: ['delete'], reversible: false } })),
    ).toMatchObject({ decidedBy: 'rules', reason: 'trusted cleanup', verdict: 'allow' });
  });

  test('accepts additional evaluators without giving them policy authority', async () => {
    const gate = new SessionGate('session-1', policy(), {
      evaluators: [
        {
          evaluate: () => ({ reason: 'extension detected risk', verdict: 'escalate' }),
          id: 'extension-risk',
        },
      ],
    });

    expect(await gate.evaluate(request())).toMatchObject({
      decidedBy: 'extension-risk',
      verdict: 'escalate',
    });
  });
});

describe('SessionGate escalation', () => {
  const escalating = (): SessionGate =>
    new SessionGate('session-1', policy({ defaultVerdict: 'escalate' }));

  test('remembers only exact calls approved for this live session', async () => {
    const gate = escalating();
    const call = request();
    const pending = await requestApproval(gate, call);

    expect(gate.resolve(pending.request.requestId, { approved: 'session' })).toBeTrue();
    expect(await pending.outcome).toEqual({ resolution: 'approved', scope: 'session' });
    expect(await gate.evaluate(call)).toMatchObject({ decidedBy: 'memo', verdict: 'allow' });
    expect(await gate.evaluate(request({ params: { command: 'ls -la' } }))).toMatchObject({
      verdict: 'escalate',
    });
  });

  test('a remembered approval never bypasses a matching deny', async () => {
    const call = request();
    const gate = new SessionGate(
      'session-1',
      policy({ rules: [{ reason: 'blocked', tools: ['bash'], verdict: 'deny' }] }),
    );
    // requestPermission is public for the runner, so even a stale or malicious
    // resolver cannot turn its memo into a bypass around deterministic policy.
    const pending = gate.requestPermission(call, {
      decidedBy: 'stale',
      decisionId: 'stale-decision',
      reason: 'stale request',
      signals: [],
      verdict: 'escalate',
    });
    gate.resolve(pending.request.requestId, { approved: 'session' });
    await pending.outcome;

    expect(await gate.evaluate(call)).toMatchObject({ reason: 'blocked', verdict: 'deny' });
  });

  test('one-off approval is not remembered and denials never are', async () => {
    const gate = escalating();
    const call = request();
    const once = await requestApproval(gate, call);
    gate.resolve(once.request.requestId, { approved: 'once' });
    await once.outcome;
    expect(await gate.evaluate(call)).toMatchObject({ verdict: 'escalate' });

    const denied = await requestApproval(gate, call);
    gate.resolve(denied.request.requestId, 'denied');
    expect(await denied.outcome).toEqual({ resolution: 'denied' });
    expect(await gate.evaluate(call)).toMatchObject({ verdict: 'escalate' });
  });

  test('times out and aborts without leaving pending requests behind', async () => {
    const timeoutGate = new SessionGate(
      'session-1',
      policy({ defaultVerdict: 'escalate', escalationTimeoutMs: 1 }),
    );
    const timed = await requestApproval(timeoutGate, request());
    expect(await timed.outcome).toEqual({ resolution: 'timeout' });
    expect(timeoutGate.listPending()).toEqual([]);

    const gate = escalating();
    const controller = new AbortController();
    const decision = await gate.evaluate(request());
    if (decision.verdict !== 'escalate') throw new Error('Expected an escalation.');
    const aborted = gate.requestPermission(request(), decision, controller.signal);
    controller.abort();
    expect(await aborted.outcome).toEqual({ resolution: 'aborted' });
    expect(gate.resolve(aborted.request.requestId, { approved: 'once' })).toBeFalse();
  });

  test('stop aborts every concurrent request', async () => {
    const gate = escalating();
    const first = await requestApproval(gate, request({ trackId: 'a' }));
    const second = await requestApproval(gate, request({ trackId: 'b' }));

    expect(gate.listPending()).toHaveLength(2);
    gate.stop();

    expect(await first.outcome).toEqual({ resolution: 'aborted' });
    expect(await second.outcome).toEqual({ resolution: 'aborted' });
    expect(gate.listPending()).toEqual([]);
  });
});
