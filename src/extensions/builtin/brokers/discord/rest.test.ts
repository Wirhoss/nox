import { silentLogger } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { DiscordRest, DiscordRestError } from './rest';

import type { SecretHandle } from '@nox/extension-api';

const CHANNEL = '300000000000000003';

const token: SecretHandle = {
  id: 'DISCORD_BOT_TOKEN',
  reveal: () => 'secret-token',
  toJSON: () => '[secret]',
  toString: () => '[secret]',
};

interface Call {
  readonly authorization: string;
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

/** A stand-in for Discord that answers whatever the test scripted, in order. */
function server(responses: (() => Response)[]): {
  calls: Call[];
  close: () => Promise<void>;
  url: string;
} {
  const calls: Call[] = [];
  let index = 0;

  const instance = Bun.serve({
    fetch: async (request) => {
      calls.push({
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next?.() ?? new Response(null, { status: 204 });
    },
    port: 0,
  });

  return {
    calls,
    close: () => instance.stop(true),
    url: instance.url.toString().replace(/\/$/, ''),
  };
}

function client(url: string): DiscordRest {
  return new DiscordRest({
    baseUrl: url,
    logger: silentLogger,
    signal: new AbortController().signal,
    token,
  });
}

describe('DiscordRest', () => {
  test('reads a channel it can reach as reachable', async () => {
    const fake = server([() => Response.json({ id: CHANNEL })]);

    try {
      expect(await client(fake.url).canReach(CHANNEL)).toBe(true);
      expect(fake.calls[0]).toMatchObject({ method: 'GET', path: `/channels/${CHANNEL}` });
    } finally {
      await fake.close();
    }
  });

  test.each([
    ['gone', 404, '{"message": "Unknown Channel", "code": 10003}'],
    ['invisible', 403, '{"message": "Missing Access", "code": 50001}'],
  ])('reports a %s channel as unreachable instead of raising', async (_name, status, body) => {
    const fake = server([() => new Response(body, { status })]);

    try {
      expect(await client(fake.url).canReach(CHANNEL)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test('raises rather than condemning an address when Discord could not be asked', async () => {
    // Four 500s exhaust the retries. Not being able to ask has to stay
    // distinguishable from having asked and been told no, or an outage would
    // read as every scheduled address suddenly being wrong.
    const fake = server([() => new Response('upstream is down', { status: 500 })]);

    try {
      expect(client(fake.url).canReach(CHANNEL)).rejects.toBeInstanceOf(DiscordRestError);
    } finally {
      await fake.close();
    }
  });

  test('posts a message as the bot and answers with the ID Discord gave it', async () => {
    const fake = server([() => Response.json({ id: '999' })]);

    try {
      const id = await client(fake.url).createMessage(CHANNEL, { content: 'hello' });

      expect(id).toBe('999');
      expect(fake.calls[0]).toMatchObject({
        authorization: 'Bot secret-token',
        body: '{"content":"hello"}',
        method: 'POST',
        path: `/channels/${CHANNEL}/messages`,
      });
    } finally {
      await fake.close();
    }
  });

  test('sends a file as multipart, declared under the index it was sent with', async () => {
    const fake = server([() => Response.json({ id: '1001' })]);

    try {
      const id = await client(fake.url).createMessage(CHANNEL, { content: 'here it is' }, [
        {
          bytes: new TextEncoder().encode('png-bytes'),
          filename: 'shot.png',
          mediaType: 'image/png',
        },
      ]);

      expect(id).toBe('1001');
      const body = fake.calls[0]?.body ?? '';
      // The message travels as `payload_json`, and the file is declared under the
      // same index it was appended with, which is what ties the two together.
      expect(body).toContain('name="payload_json"');
      expect(body).toContain(
        '{"content":"here it is","attachments":[{"filename":"shot.png","id":0}]}',
      );
      expect(body).toContain('name="files[0]"; filename="shot.png"');
      expect(body).toContain('png-bytes');
    } finally {
      await fake.close();
    }
  });

  test('waits out a rate limit and then succeeds', async () => {
    const fake = server([
      () => Response.json({ retry_after: 0.01 }, { status: 429 }),
      () => Response.json({ id: '1000' }),
    ]);

    try {
      const id = await client(fake.url).createMessage(CHANNEL, { content: 'hi' });

      expect(id).toBe('1000');
      expect(fake.calls).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });

  test('never retries a refusal that would be refused again', async () => {
    const fake = server([() => new Response('Missing Permissions', { status: 403 })]);

    try {
      const failure = client(fake.url)
        .createMessage(CHANNEL, { content: 'hi' })
        .catch((error: unknown) => error);

      const error = await failure;
      expect(error).toBeInstanceOf(DiscordRestError);
      expect((error as DiscordRestError).status).toBe(403);
      // A missing permission is answered the same way however many times it is
      // asked; retrying it only delays telling somebody.
      expect(fake.calls).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  test('keeps one channel in order, so a split reply arrives as it was written', async () => {
    const fake = server([() => Response.json({ id: 'x' })]);
    const rest = client(fake.url);

    try {
      await Promise.all([
        rest.createMessage(CHANNEL, { content: 'first' }),
        rest.createMessage(CHANNEL, { content: 'second' }),
        rest.createMessage(CHANNEL, { content: 'third' }),
      ]);

      expect(fake.calls.map((call) => JSON.parse(call.body) as { content: string })).toEqual([
        { content: 'first' },
        { content: 'second' },
        { content: 'third' },
      ]);
    } finally {
      await fake.close();
    }
  });

  test('replaces the whole guild command list rather than adding to it', async () => {
    const fake = server([() => Response.json([])]);

    try {
      await client(fake.url).publishCommands('app', 'guild', [
        { description: 'Stops the agent.', name: 'stop', options: [] },
      ]);

      expect(fake.calls[0]).toMatchObject({
        method: 'PUT',
        path: '/applications/app/guilds/guild/commands',
      });
    } finally {
      await fake.close();
    }
  });

  test('publishes globally where no server was configured', async () => {
    const fake = server([() => Response.json([])]);

    try {
      await client(fake.url).publishCommands('app', undefined, [
        { description: 'Stops the agent.', name: 'stop', options: [] },
      ]);

      // The global list is the only one a second server or a direct message sees.
      expect(fake.calls[0]).toMatchObject({
        method: 'PUT',
        path: '/applications/app/commands',
      });
    } finally {
      await fake.close();
    }
  });
});
