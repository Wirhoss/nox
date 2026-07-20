import { describe, expect, test } from 'bun:test';

import { EscalationHub } from './escalation';
import { ToolGate } from './gate';

import type { ToolCallMessage } from '../provider';

function call(name: string, args: Record<string, unknown> = {}): ToolCallMessage {
  return { role: 'toolCall', name, trackId: 'track-1', arguments: args };
}

describe('ToolGate', () => {
  test('passes when no rule matches', () => {
    const gate = new ToolGate([
      { tools: ['bash'], verdict: 'deny', reason: 'no shell' },
    ]);
    expect(gate.evaluate(call('readFile', { path: '/tmp/x' }))).toEqual({ verdict: 'pass' });
  });

  test('denies on tool name plus argument regex', () => {
    const gate = new ToolGate([
      {
        tools: ['bash'],
        match: { command: 'rm\\s+(-[a-z]*r[a-z]*f|--recursive)' },
        verdict: 'deny',
        reason: 'Recursive delete is hard-blocked.',
      },
    ]);
    expect(gate.evaluate(call('bash', { command: 'rm -rf /' })).verdict).toBe('deny');
    expect(gate.evaluate(call('bash', { command: 'ls -la' })).verdict).toBe('pass');
  });

  test('a rule with a matcher does not fire when the argument is missing', () => {
    const gate = new ToolGate([
      { tools: ['bash'], match: { command: 'rm' }, verdict: 'deny', reason: 'x' },
    ]);
    expect(gate.evaluate(call('bash', {})).verdict).toBe('pass');
  });

  test('deny wins over escalate regardless of rule order', () => {
    const gate = new ToolGate([
      { tools: ['bash'], verdict: 'escalate', reason: 'shell needs approval' },
      { tools: ['bash'], match: { command: 'sudo' }, verdict: 'deny', reason: 'no sudo' },
    ]);
    expect(gate.evaluate(call('bash', { command: 'sudo reboot' }))).toEqual({ verdict: 'deny', reason: 'no sudo' });
    expect(gate.evaluate(call('bash', { command: 'ls' }))).toEqual({ verdict: 'escalate', reason: 'shell needs approval' });
  });

  test('wildcard rules apply to every tool', () => {
    const gate = new ToolGate([
      { tools: '*', verdict: 'escalate', reason: 'paranoid mode' },
    ]);
    expect(gate.evaluate(call('anything')).verdict).toBe('escalate');
  });

  test('non-string arguments are matched against their JSON', () => {
    const gate = new ToolGate([
      { tools: ['deleteFiles'], match: { paths: '/etc' }, verdict: 'deny', reason: 'system paths' },
    ]);
    expect(gate.evaluate(call('deleteFiles', { paths: ['/etc/passwd'] })).verdict).toBe('deny');
    expect(gate.evaluate(call('deleteFiles', { paths: ['/tmp/x'] })).verdict).toBe('pass');
  });

  test('an invalid regex fails at construction, not at call time', () => {
    expect(() => new ToolGate([
      { tools: ['bash'], match: { command: '([' }, verdict: 'deny', reason: 'broken' },
    ])).toThrow();
  });
});

describe('EscalationHub', () => {
  test('resolve answers a pending wait', async () => {
    const hub = new EscalationHub();
    const pending = hub.wait('r1', 1_000);
    expect(hub.resolve('r1', true)).toBe(true);
    expect(await pending).toBe('approved');
  });

  test('times out into a denial-shaped resolution', async () => {
    const hub = new EscalationHub();
    expect(await hub.wait('r1', 10)).toBe('timeout');
    expect(hub.has('r1')).toBe(false);
  });

  test('abort resolves the wait', async () => {
    const hub = new EscalationHub();
    const controller = new AbortController();
    const pending = hub.wait('r1', 1_000, controller.signal);
    controller.abort();
    expect(await pending).toBe('aborted');
  });

  test('listPending exposes request metadata until resolution', async () => {
    const hub = new EscalationHub();
    const pending = hub.wait('r1', 1_000, undefined, {
      toolName: 'shell',
      toolArguments: { cmd: 'rm -rf /' },
      reason: 'destructive command',
    });

    const [entry] = hub.listPending();
    expect(entry?.requestId).toBe('r1');
    expect(entry?.toolName).toBe('shell');
    expect(entry?.toolArguments).toEqual({ cmd: 'rm -rf /' });
    expect(entry?.reason).toBe('destructive command');
    expect((entry?.expiresAt ?? 0) - (entry?.requestedAt ?? 0)).toBe(1_000);

    hub.resolve('r1', true);
    await pending;
    expect(hub.listPending()).toEqual([]);
  });

  test('resolving an unknown or settled request returns false', async () => {
    const hub = new EscalationHub();
    expect(hub.resolve('ghost', true)).toBe(false);
    const pending = hub.wait('r1', 1_000);
    hub.resolve('r1', false);
    expect(await pending).toBe('denied');
    expect(hub.resolve('r1', true)).toBe(false);
  });
});
