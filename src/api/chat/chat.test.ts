import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';
import {
  type ChatDecisionInput,
  type ChatEvent,
  ChatHub,
  type ChatListener,
  type ChatMessageInput,
  type ChatTransport,
} from './transport';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';
const CONVERSATION = 'nJ8xKqLm2p';

/** A transport that remembers what it was handed instead of carrying it anywhere. */
class RecordingTransport implements ChatTransport {
  public readonly decisions: ChatDecisionInput[] = [];
  public readonly listeners = new Set<ChatListener>();
  public readonly messages: ChatMessageInput[] = [];

  public emit(event: ChatEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public submitDecision(input: ChatDecisionInput): void {
    this.decisions.push(input);
  }

  public submitMessage(input: ChatMessageInput): void {
    this.messages.push(input);
  }

  public subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

interface ChatNox {
  readonly accountId: string;
  readonly headers: Record<string, string>;
  readonly hub: ChatHub;
  readonly url: string;
}

/** A claimed Nox with one account logged in and the chat routes mounted. */
async function chatNox(): Promise<ChatNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-chat-'));
  directories.push(directory);
  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);

  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('esteban', PASSWORD);
  const tokens = await store.openSession(account.accountId);

  const hub = new ChatHub();
  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store },
    chat: hub,
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
  });
  await server.listen();
  servers.push(server);

  return {
    accountId: account.accountId,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    hub,
    url: server.url,
  };
}

/** Polls until a condition holds, so a test never depends on how a stream is scheduled. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the condition to hold.');
}

/**
 * The next complete SSE frame, comments included. The reader is described by
 * what it does rather than by its type: Bun's stream reader and the DOM one
 * differ in ways this does not use.
 */
async function nextFrame(reader: {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (!buffer.includes('\n\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  return buffer;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      // Windows can retain a SQLite handle briefly after close; the OS temp
      // directory is disposable, so cleanup timing is not the assertion here.
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('the chat routes', () => {
  test('say nothing to a request without a token', async () => {
    const { url } = await chatNox();

    const stream = await fetch(`${url}/chat/stream`);
    const message = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ text: 'hola' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(stream.status).toBe(401);
    expect(message.status).toBe(401);
  });

  test('answer that the chat is unavailable while no broker holds the surface', async () => {
    const { headers, url } = await chatNox();

    const stream = await fetch(`${url}/chat/stream`, { headers });
    const message = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ text: 'hola' }),
      headers,
      method: 'POST',
    });

    expect(stream.status).toBe(503);
    expect(await message.json()).toEqual({ error: 'chat_unavailable' });
  });

  test('hand a message over under the account that sent it', async () => {
    const { accountId, headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const response = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ text: 'revisa mis correos' }),
      headers,
      method: 'POST',
    });

    // Accepted, not answered: the reply is a run, and it arrives on the stream.
    expect(response.status).toBe(202);
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      conversationId: CONVERSATION,
      senderId: accountId,
      text: 'revisa mis correos',
    });
  });

  test('keep the message id a client chose, and mint one when it did not', async () => {
    const { headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const chosen = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ messageId: 'retry-me', text: 'hola' }),
      headers,
      method: 'POST',
    });
    await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ text: 'hola otra vez' }),
      headers,
      method: 'POST',
    });

    expect(await chosen.json()).toEqual({ messageId: 'retry-me' });
    expect(transport.messages[0]?.messageId).toBe('retry-me');
    // A client that names nothing still gets an id, or a retry could not be one.
    expect(transport.messages[1]?.messageId).toBeString();
    expect(transport.messages[1]?.messageId).not.toBe('retry-me');
  });

  test('refuse a conversation id that is not a generated one', async () => {
    const { headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const response = await fetch(`${url}/chat/conversations/not%20an%20id/messages`, {
      body: JSON.stringify({ text: 'hola' }),
      headers,
      method: 'POST',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(transport.messages).toBeEmpty();
  });

  test('carry an answer to a pending request, with the scope it was given', async () => {
    const { accountId, headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const approved = await fetch(
      `${url}/chat/conversations/${CONVERSATION}/permissions/request-1`,
      {
        body: JSON.stringify({ decision: 'approve', scope: 'session' }),
        headers,
        method: 'POST',
      },
    );
    await fetch(`${url}/chat/conversations/${CONVERSATION}/permissions/request-2`, {
      body: JSON.stringify({ decision: 'deny' }),
      headers,
      method: 'POST',
    });

    expect(approved.status).toBe(202);
    expect(transport.decisions).toEqual([
      {
        conversationId: CONVERSATION,
        decision: 'approve',
        requestId: 'request-1',
        scope: 'session',
        senderId: accountId,
      },
      {
        conversationId: CONVERSATION,
        decision: 'deny',
        requestId: 'request-2',
        scope: undefined,
        senderId: accountId,
      },
    ]);
  });

  test('stream what the transport renders, named by its type', async () => {
    const { headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const controller = new AbortController();
    const response = await fetch(`${url}/chat/stream`, {
      headers,
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    if (response.body === null) throw new Error('The stream had no body.');

    const reader = response.body.getReader();
    expect(await nextFrame(reader)).toContain(': open');

    await until(() => transport.listeners.size === 1);
    transport.emit({
      conversationId: CONVERSATION,
      text: 'listo',
      turnId: 'run-1',
      type: 'message',
    });

    const frame = await nextFrame(reader);
    expect(frame).toContain('event: message');
    expect(frame).toContain('"text":"listo"');

    controller.abort();
  });

  test('let go of the subscription when the client disappears', async () => {
    const { headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const controller = new AbortController();
    await fetch(`${url}/chat/stream`, { headers, signal: controller.signal });
    await until(() => transport.listeners.size === 1);

    controller.abort();

    // A closed tab must not leave a listener behind, or a long-lived Nox
    // accumulates one per visit.
    await until(() => transport.listeners.size === 0);
  });
});

describe('the chat hub', () => {
  test('holds one transport and refuses a second', () => {
    const hub = new ChatHub();
    const first = new RecordingTransport();

    const detach = hub.attach(first);

    expect(hub.transport).toBe(first);
    expect(() => hub.attach(new RecordingTransport())).toThrow(/exactly one broker/);

    detach();
    expect(hub.transport).toBeUndefined();
  });

  test('ignores a detach from a transport that no longer holds it', () => {
    const hub = new ChatHub();
    const first = new RecordingTransport();
    const second = new RecordingTransport();

    const detachFirst = hub.attach(first);
    detachFirst();
    hub.attach(second);
    detachFirst();

    expect(hub.transport).toBe(second);
  });
});
