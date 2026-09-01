import { join } from 'node:path';

import { bindSetTool } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../../logger/logger';
import { ExtensionProcess } from './host';
import { RemoteToolSet } from './toolSet';

import type { MessageContent, PreparedToolCall, ToolContext } from '@nox/extension-api';

const GREETER = join(import.meta.dir, 'fixtures', 'greeter.ts');

/**
 * A tool set living in a second process, reached exactly the way the kernel
 * reaches any other one.
 *
 * Unconfined here, because these run wherever the suite runs; the same set
 * behind a real Landlock and seccomp ruleset is measured by the probe. What is
 * under test is that nothing on the reading side has to know the difference.
 */
async function connected(): Promise<{ dispose: () => Promise<void>; toolSet: RemoteToolSet }> {
  const host = new ExtensionProcess({
    allowances: [],
    extensionId: 'test.greeter',
    logger: silentLogger,
    runUnconfined: true,
  });
  await host.load(GREETER);
  await host.invoke('toolset.bind', 'greeter-instance', 'toolSet');
  const toolSet = await RemoteToolSet.connect(host.scoped('greeter-instance'));
  return { dispose: () => host.dispose(), toolSet };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { abortSignal: new AbortController().signal, ...overrides };
}

function textOf(content: readonly MessageContent[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)).join('');
}

describe('RemoteToolSet', () => {
  test("reports the far side's name, description and declarations", async () => {
    const { dispose, toolSet } = await connected();
    try {
      expect(toolSet.name).toBe('greeter');
      expect(toolSet.description).toBe('Greets, slowly or otherwise.');
      expect(Object.keys(toolSet.declarations).sort()).toEqual(['greet', 'ponder']);

      // The declaration is data all the way down, including the parameter
      // schema — which started life as a Zod object in another process.
      const greet = toolSet.declarations.greet;
      expect(greet?.authority).toBe('test.greeter.greet');
      expect(greet?.parameters).toMatchObject({
        properties: { name: { type: 'string' } },
        required: ['name'],
        type: 'object',
      });
    } finally {
      await dispose();
    }
  });

  test('prepares and runs an immediate call across the boundary', async () => {
    const { dispose, toolSet } = await connected();
    try {
      const prepared = await toolSet.prepare('greet', { name: 'ada' });
      expect(prepared.type).toBe('immediate');
      expect(prepared.title).toBe('Greet ada');
      expect(prepared.preview).toBe('greet ada');
      expect(prepared.params).toEqual({ name: 'ada' });
      expect(textOf(await runImmediate(prepared))).toBe('hello ada');
    } finally {
      await dispose();
    }
  });

  test('rejects parameters the far side considers invalid', async () => {
    // Validation happens where the schema is, which is the only place it can:
    // the host holds a JSON Schema, not a validator.
    const { dispose, toolSet } = await connected();
    try {
      const failure = await toolSet.prepare('greet', { name: '' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.toLowerCase()).toContain('greet');
    } finally {
      await dispose();
    }
  });

  test('rejects a tool the far side does not have', async () => {
    const { dispose, toolSet } = await connected();
    try {
      const failure = await toolSet.prepare('nope', {}).catch((error: unknown) => error);
      expect((failure as Error).message).toContain('nope');
    } finally {
      await dispose();
    }
  });

  test('acknowledges a deferred call before its result is ready', async () => {
    const { dispose, toolSet } = await connected();
    try {
      const prepared = await toolSet.prepare('ponder', { ms: 40 });
      expect(prepared.type).toBe('deferred');
      if (prepared.type !== 'deferred') throw new Error('unreachable');

      const { ack, result } = await prepared.run(context());
      expect(textOf(ack)).toBe('thinking');
      // The ack arrived first and the result is still in flight — which is the
      // entire distinction a deferred execution makes, preserved across two
      // messages instead of one.
      expect(textOf(await result)).toBe('pondered for 40ms');
    } finally {
      await dispose();
    }
  });

  test('carries an abort across as a message', async () => {
    // An AbortSignal does not survive a JSON document. The signal the tool sees
    // is created in the child and armed by `toolset.abort`, so this failing
    // would mean cancellation silently did nothing — work continuing in a
    // process nobody is watching.
    const { dispose, toolSet } = await connected();
    try {
      const prepared = await toolSet.prepare('ponder', { ms: 5_000 });
      if (prepared.type !== 'deferred') throw new Error('unreachable');
      const controller = new AbortController();
      const { result } = await prepared.run(context({ abortSignal: controller.signal }));
      controller.abort();
      const failure = await result.catch((error: unknown) => error);
      // The name survives the crossing, so the runner can still tell a
      // cancellation from a failure — the one thing callers branch on.
      expect((failure as Error).name).toBe('AbortError');
    } finally {
      await dispose();
    }
  });

  test('binds into the tool table like any other set', async () => {
    // The point of the whole exercise: `bindSetTool` is the kernel's own path
    // to a granted set, and it neither knows nor can tell that this one is in
    // another process.
    const { dispose, toolSet } = await connected();
    try {
      const bound = bindSetTool(toolSet, 'greet', 'greeter-1');
      expect(bound.declaration.name).toBe('greet');

      const prepared = await bound.prepare({ name: 'grace' });
      // The gate subject is stamped by the binding, on this side, from the
      // declaration — an extension does not get to name the authority it is
      // authorized against.
      expect(prepared.gateSubject).toMatchObject({
        authority: 'test.greeter.greet',
        params: { name: 'grace' },
        toolName: 'greet',
        toolSetId: 'greeter-1',
        trust: 'untrusted',
      });
      expect(textOf(await runImmediate(prepared))).toBe('hello grace');
    } finally {
      await dispose();
    }
  });
});

async function runImmediate(prepared: PreparedToolCall): Promise<MessageContent[]> {
  if (prepared.type !== 'immediate') throw new Error('Expected an immediate call.');
  return await prepared.run(context());
}
