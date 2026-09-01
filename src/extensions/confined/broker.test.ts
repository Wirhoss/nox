import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { artifactConversationScope } from '../../artifact/types';
import { silentLogger } from '../../logger/logger';
import { connectBroker } from './broker';
import { ExtensionProcess } from './host';

import type { Logger } from '../../logger/logger';
import type { Broker, BrokerHost } from '@nox/extension-api';

const MEGAPHONE = join(import.meta.dir, 'fixtures', 'megaphone.ts');

interface Wired {
  readonly broker: Broker;
  readonly dispose: () => Promise<void>;
  readonly host: ExtensionProcess;
  readonly received: unknown[];
}

/** A `BrokerHost` that records what the transport asked it, and answers. */
function hostFor(received: unknown[]): BrokerHost {
  return {
    agentIds: () => ['analyst', 'scribe'],
    artifactScope: () => {
      throw new Error('The child answers this one itself.');
    },
    command: (invocation) => {
      received.push({ command: invocation });
      return Promise.resolve(undefined);
    },
    commands: [{ description: 'Say hello.', name: 'hi', parameters: { type: 'object' } }],
    defaultAgentId: 'analyst',
    history: (conversationId) => {
      received.push({ history: conversationId });
      return Promise.resolve({
        agentId: 'analyst',
        conversationId,
        entries: [],
        sessionId: 's-1',
      });
    },
    logger: silentLogger,
    receive: (event) => {
      received.push({ receive: event });
      return Promise.resolve(undefined);
    },
    // Two `Date`s, travelling the direction that did not exist until now.
    sessions: () =>
      Promise.resolve([
        {
          agentId: 'analyst',
          conversationId: 'room-1',
          sessionId: 's-1',
          startedAt: new Date('2026-08-31T09:00:00.000Z'),
          state: 'idle' as const,
          updatedAt: new Date('2026-08-31T09:05:00.000Z'),
        },
      ]),
    signal: new AbortController().signal,
  };
}

async function wired(factory: 'full' | 'sparse', logger: Logger = silentLogger): Promise<Wired> {
  const host = new ExtensionProcess({
    allowances: [],
    extensionId: 'test.megaphone',
    logger,
    runUnconfined: true,
  });
  await host.load(MEGAPHONE);
  await host.invoke('broker.bind', 'megaphone-instance', factory);
  const received: unknown[] = [];
  const broker = await connectBroker({
    brokerId: 'megaphone-1',
    channel: host.scoped('megaphone-instance'),
  });
  await broker.start(hostFor(received));
  return { broker, dispose: () => host.dispose(), host, received };
}

describe('connectBroker', () => {
  test('delivers an outbound event to the transport', async () => {
    const { broker, dispose, host } = await wired('full');
    try {
      await broker.deliver({
        body: { content: [{ text: 'hi', type: 'text' }], kind: 'message' },
        conversationId: 'room-1',
        turnId: 't-1',
      } as never);
      expect(await host.invoke('delivered')).toMatchObject([{ conversationId: 'room-1' }]);
    } finally {
      await dispose();
    }
  });

  test('carries a callback from the transport into the host', async () => {
    // The direction that did not exist until now. A transport that could only
    // be spoken to could not deliver anything: every message that arrives on a
    // real broker starts as one of these.
    const { dispose, host, received } = await wired('full');
    try {
      expect(await host.invoke('callReceive', 'hello there')).toBeUndefined();
      expect(received).toMatchObject([{ receive: { conversationId: 'room-1' } }]);
    } finally {
      await dispose();
    }
  });

  test('answers the host callbacks that return values', async () => {
    const { dispose, host, received } = await wired('full');
    try {
      expect(await host.invoke('callAgentIds')).toEqual(['analyst', 'scribe']);
      expect(await host.invoke('callHistory', 'room-1')).toMatchObject({ sessionId: 's-1' });
      expect(received).toMatchObject([{ history: 'room-1' }]);
    } finally {
      await dispose();
    }
  });

  test('carries Dates into the child, the direction the codec had not been used in', async () => {
    // `BrokerSession` has two. Answered by the host and read inside the child,
    // so this is the reverse crossing — and it would pass as ISO strings
    // without anyone noticing until a transport formatted one.
    const { dispose, host } = await wired('full');
    try {
      expect(await host.invoke('sessionDateTypes')).toEqual(['Date,Date']);
    } finally {
      await dispose();
    }
  });

  test('gives the transport the host’s own artifact scope, without asking', async () => {
    // Derived in the child from the broker id the host assigned, not chosen by
    // the transport and not a round trip. The scope is what keeps an artifact
    // ID from being a way to read another conversation's files, so this has to
    // be exactly what the gateway would have produced.
    const { dispose, host } = await wired('full');
    try {
      expect(await host.invoke('callArtifactScope', 'room-1')).toEqual(
        artifactConversationScope('megaphone-1', 'room-1'),
      );
    } finally {
      await dispose();
    }
  });

  test('states the host’s commands without a crossing', async () => {
    const { dispose, host } = await wired('full');
    try {
      expect(await host.invoke('callCommands')).toEqual([
        { description: 'Say hello.', name: 'hi', parameters: { type: 'object' } },
      ]);
    } finally {
      await dispose();
    }
  });

  test('carries a log line out of the confined process', async () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const { dispose, host } = await wired('full', {
      ...silentLogger,
      info: (fields, message) => lines.push({ fields: { ...fields }, message }),
    });
    try {
      await host.invoke('log', 'from inside the transport');
      expect(lines).toMatchObject([
        {
          // Stamped by the host: a package cannot write a line claiming to be
          // somebody else.
          fields: { extensionId: 'test.megaphone', logger: 'broker', shouted: true },
          message: 'from inside the transport',
        },
      ]);
    } finally {
      await dispose();
    }
  });

  test('reports the transport’s optional members exactly', async () => {
    const complete = await wired('full');
    const bare = await wired('sparse');
    try {
      // The contract declares these as methods, so reading them off the object
      // trips `unbound-method`. Nothing here is `this`-dependent: what
      // `connectBroker` returns is a frozen record of closures, and reading
      // them is exactly what the host does to decide whether they exist.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const { canDeliverTo, openScheduledConversation, principalGroups } = complete.broker;
      expect(complete.broker.capabilities).toEqual({ commands: true, streaming: true });
      expect(await canDeliverTo?.('room-1', new AbortController().signal)).toBe(true);
      expect(await canDeliverTo?.('dm-1', new AbortController().signal)).toBe(false);
      expect(await openScheduledConversation?.()).toBe('room-scheduled');
      expect(await principalGroups?.('ada')).toEqual(['admins']);

      // A transport is allowed to be only this. Absent means the host accepts
      // an address it cannot check — not that checking always fails.
      expect(Object.hasOwn(bare.broker, 'canDeliverTo')).toBe(false);
      expect(Object.hasOwn(bare.broker, 'openScheduledConversation')).toBe(false);
      expect(Object.hasOwn(bare.broker, 'principalGroups')).toBe(false);
    } finally {
      await complete.dispose();
      await bare.dispose();
    }
  });

  test('aborts the transport’s signal when it is stopped', async () => {
    const { broker, dispose, host } = await wired('full');
    try {
      expect(await host.invoke('stopped')).toBe(false);
      await broker.stop();
      // `stop` clears the fixture's host, so the signal is read before the
      // transport forgets it — the assertion is that stopping reached it.
      expect(await host.invoke('broker.shape', 'megaphone-instance')).toMatchObject({
        canDeliverTo: true,
      });
    } finally {
      await dispose();
    }
  });

  test('refuses a callback the host does not implement', async () => {
    // A method nobody registered is refused by name rather than ignored: a
    // transport waiting forever on a callback that was never wired is the exact
    // failure this direction exists to make visible.
    const { dispose, host } = await wired('full');
    try {
      const failure = await host
        .invoke('brokerhost.nonsense')
        .catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain('nonsense');
    } finally {
      await dispose();
    }
  });
});
