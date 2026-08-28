import { type SecretHandle, silentLogger } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { DiscordSocket } from './socket';

import type { ServerWebSocket } from 'bun';

const token: SecretHandle = {
  id: 'DISCORD_BOT_TOKEN',
  reveal: () => 'secret-token',
  toJSON: () => '[secret]',
  toString: () => '[secret]',
};

const READY = {
  d: {
    guilds: [{ id: 'guild-1' }, { id: 'guild-2' }],
    resume_gateway_url: 'wss://resume.invalid',
    session_id: 'session-1',
    user: { id: '42', username: 'noxbot' },
  },
  op: 0,
  s: 1,
  t: 'READY',
};

interface Frame {
  readonly d?: unknown;
  readonly op: number;
}

interface FakeGateway {
  readonly close: () => void;
  readonly received: Frame[];
  readonly send: (payload: unknown) => void;
  readonly url: string;
}

/**
 * A stand-in for Discord's gateway: it says HELLO on connect and hands every
 * frame it receives to the test, which decides what happens next.
 */
function gateway(onFrame: (ws: ServerWebSocket<unknown>, frame: Frame) => void): FakeGateway {
  const received: Frame[] = [];
  let live: ServerWebSocket<unknown> | undefined;

  const server = Bun.serve({
    fetch: (request, instance) => {
      if (instance.upgrade(request)) return undefined;
      return new Response('expected a websocket', { status: 400 });
    },
    port: 0,
    websocket: {
      message: (ws, raw) => {
        const frame = JSON.parse(String(raw)) as Frame;
        received.push(frame);
        onFrame(ws, frame);
      },
      open: (ws) => {
        live = ws;
        ws.send(JSON.stringify({ d: { heartbeat_interval: 40 }, op: 10 }));
      },
    },
  });

  return {
    // Not awaited: stopping a server whose only connection it closed itself does
    // not settle here, and the test has nothing left to wait for either way.
    close: () => {
      void server.stop(true);
    },
    received,
    send: (payload) => {
      live?.send(JSON.stringify(payload));
    },
    url: `ws://localhost:${String(server.port)}`,
  };
}

function connectTo(
  fake: FakeGateway,
  onDispatch: (type: string, data: Record<string, unknown>) => void = () => undefined,
): DiscordSocket {
  return new DiscordSocket({
    gatewayUrl: fake.url,
    logger: silentLogger,
    onDispatch,
    signal: new AbortController().signal,
    token,
  });
}

/** Waits for a condition the fake gateway will make true, or gives up. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the gateway.');
    await Bun.sleep(5);
  }
}

describe('DiscordSocket', () => {
  test('a fault while handling a frame fails connect instead of the process', async () => {
    const fake = gateway(() => undefined);
    const socket = new DiscordSocket({
      gatewayUrl: fake.url,
      logger: silentLogger,
      onDispatch: () => undefined,
      signal: new AbortController().signal,
      // Exactly the shape a broker gets when the secret its configuration names
      // has no stored value: the type says the handle is there, the object has
      // no such property. Reading it throws inside the socket's own message
      // listener, where nothing above can catch it.
      token: undefined as unknown as SecretHandle,
    });

    try {
      // The contract that matters is that this settles at all. Unguarded, the
      // throw escapes the listener as an uncaught exception and takes the
      // process down, so the gateway never gets to report one failed transport
      // and keep the others.
      let failure: unknown;
      await socket.connect().catch((error: unknown) => {
        failure = error;
      });

      expect(failure).toBeInstanceOf(Error);
    } finally {
      socket.close();
      fake.close();
    }
  });

  test('identifies with the bot token and resolves once Discord says ready', async () => {
    const fake = gateway((ws, frame) => {
      if (frame.op === 2) ws.send(JSON.stringify(READY));
    });
    const socket = connectTo(fake);

    try {
      const identity = await socket.connect();

      expect(identity).toEqual({
        guildIds: ['guild-1', 'guild-2'],
        id: '42',
        username: 'noxbot',
      });
      expect(socket.identity).toEqual(identity);

      const identify = fake.received.find((frame) => frame.op === 2);
      expect(identify?.d).toMatchObject({ token: 'secret-token' });
    } finally {
      socket.close();
      fake.close();
    }
  });

  test('asks for message content, without which every message would be empty', async () => {
    const fake = gateway((ws, frame) => {
      if (frame.op === 2) ws.send(JSON.stringify(READY));
    });
    const socket = connectTo(fake);

    try {
      await socket.connect();

      const identify = fake.received.find((frame) => frame.op === 2);
      const intents = (identify?.d as { intents: number }).intents;
      expect(intents & (1 << 15)).toBeGreaterThan(0);
    } finally {
      socket.close();
      fake.close();
    }
  });

  test('keeps beating so the connection is not dropped as idle', async () => {
    const fake = gateway((ws, frame) => {
      if (frame.op === 2) ws.send(JSON.stringify(READY));
      if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
    });
    const socket = connectTo(fake);

    try {
      await socket.connect();
      await until(() => fake.received.filter((frame) => frame.op === 1).length >= 2);
    } finally {
      socket.close();
      fake.close();
    }
  });

  test('hands dispatched events to its owner and keeps nothing else', async () => {
    const seen: string[] = [];
    const fake = gateway((ws, frame) => {
      if (frame.op === 2) ws.send(JSON.stringify(READY));
    });
    const socket = connectTo(fake, (type) => {
      seen.push(type);
    });

    try {
      await socket.connect();
      fake.send({ d: { content: 'hi', id: '7' }, op: 0, s: 2, t: 'MESSAGE_CREATE' });
      await until(() => seen.includes('MESSAGE_CREATE'));

      // READY is the socket's own business; the broker above never sees it.
      expect(seen).toEqual(['MESSAGE_CREATE']);
    } finally {
      socket.close();
      fake.close();
    }
  });

  test('gives up on a refusal that reconnecting cannot fix', async () => {
    const fake = gateway((ws, frame) => {
      // 4004 is a bad token: the same answer however many times it is asked.
      if (frame.op === 2) ws.close(4004, 'Authentication failed.');
    });
    const socket = connectTo(fake);

    try {
      const error = await socket.connect().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('4004');

      const identifies = fake.received.filter((frame) => frame.op === 2).length;
      await Bun.sleep(120);
      expect(fake.received.filter((frame) => frame.op === 2).length).toBe(identifies);
    } finally {
      socket.close();
      fake.close();
    }
  });
});
