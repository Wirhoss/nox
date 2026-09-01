import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { ArtifactPipeline } from '../../artifact/pipeline';
import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';
import { ChatHub } from './transport';

import type {
  ChatCommand,
  ChatCommandInput,
  ChatCommandRejection,
  ChatConversation,
  ChatDecisionInput,
  ChatEvent,
  ChatHistory,
  ChatHistoryInput,
  ChatListener,
  ChatMessageInput,
  ChatMessageRejection,
  ChatTransport,
} from '@nox/extension-api';

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
  public readonly invocations: ChatCommandInput[] = [];
  public readonly reads: ChatHistoryInput[] = [];
  public readonly steers: ChatMessageInput[] = [];

  #nextEventId = 0;

  /** What the gateway would refuse with, set by whichever test cares. */
  public rejection: ChatCommandRejection | undefined;
  public messageRejection: ChatMessageRejection | undefined;

  /** What the gateway would answer with, set by whichever test cares. */
  public commands: readonly ChatCommand[] = [];
  public conversations: readonly ChatConversation[] = [];
  public history: ChatHistory | undefined;

  public emit(event: ChatEvent): void {
    const eventId = ++this.#nextEventId;
    for (const listener of this.listeners) listener(event, eventId);
  }

  public listAgents(): { readonly agents: readonly string[] } {
    return { agents: ['nox'] };
  }

  public listCommands(): readonly ChatCommand[] {
    return this.commands;
  }

  public listConversations(): Promise<readonly ChatConversation[]> {
    return Promise.resolve(this.conversations);
  }

  public readHistory(input: ChatHistoryInput): Promise<ChatHistory | undefined> {
    this.reads.push(input);
    return Promise.resolve(this.history);
  }

  public submitCommand(input: ChatCommandInput): Promise<ChatCommandRejection | undefined> {
    this.invocations.push(input);
    return Promise.resolve(this.rejection);
  }

  public submitDecision(input: ChatDecisionInput): void {
    this.decisions.push(input);
  }

  public submitMessage(input: ChatMessageInput): Promise<ChatMessageRejection | undefined> {
    this.messages.push(input);
    return Promise.resolve(this.messageRejection);
  }

  public submitSteer(input: ChatMessageInput): Promise<ChatMessageRejection | undefined> {
    this.steers.push(input);
    return Promise.resolve(this.messageRejection);
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

  const artifacts = await ArtifactPipeline.open({
    dataDirectory: directory,
    database,
    logger: silentLogger,
  });
  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('wirhoss', PASSWORD);
  const tokens = await store.openSession(account.accountId);

  const hub = new ChatHub();
  const server = ApiServer.create({
    artifacts,
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
    url: `${server.url}/api`,
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
      body: JSON.stringify({ content: [{ text: 'hola', type: 'text' }] }),
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
      body: JSON.stringify({ content: [{ text: 'hola', type: 'text' }] }),
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
      body: JSON.stringify({ content: [{ text: 'revisa mis correos', type: 'text' }] }),
      headers,
      method: 'POST',
    });

    // Accepted, not answered: the reply is a run, and it arrives on the stream.
    expect(response.status).toBe(202);
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      content: [{ text: 'revisa mis correos', type: 'text' }],
      conversationId: CONVERSATION,
      senderId: accountId,
    });
  });

  test('stores an uploaded file and hands only its canonical artifact reference to chat', async () => {
    const { accountId, headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);
    const uploaded = await fetch(`${url}/artifacts`, {
      body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      headers: {
        ...headers,
        'content-type': 'image/webp',
        'x-artifact-filename': encodeURIComponent('object.png'),
      },
      method: 'POST',
    });
    const artifact = (await uploaded.json()) as {
      artifactId: string;
      filename: string;
      mediaType: string;
      size: number;
    };
    const submitted = [
      { text: 'What is this?', type: 'text' },
      // Every field except the ID is untrusted at message ingress and replaced.
      { artifact: { ...artifact, filename: 'forged.exe', size: 1 }, type: 'artifact' },
    ];

    const response = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ content: submitted }),
      headers,
      method: 'POST',
    });

    expect(uploaded.status).toBe(201);
    expect(response.status).toBe(202);
    expect(transport.messages[0]).toMatchObject({
      content: [
        { text: 'What is this?', type: 'text' },
        {
          artifact: {
            artifactId: artifact.artifactId,
            filename: 'object.png',
            mediaType: 'image/png',
            size: 8,
          },
          type: 'artifact',
        },
      ],
      conversationId: CONVERSATION,
      senderId: accountId,
    });
  });

  test('keep the message id a client chose, and mint one when it did not', async () => {
    const { headers, hub, url } = await chatNox();
    const transport = new RecordingTransport();
    hub.attach(transport);

    const chosen = await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ content: [{ text: 'hola', type: 'text' }], messageId: 'retry-me' }),
      headers,
      method: 'POST',
    });
    await fetch(`${url}/chat/conversations/${CONVERSATION}/messages`, {
      body: JSON.stringify({ content: [{ text: 'hola otra vez', type: 'text' }] }),
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
      body: JSON.stringify({ content: [{ text: 'hola', type: 'text' }] }),
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
      content: [{ text: 'listo', type: 'text' }],
      conversationId: CONVERSATION,
      text: 'listo',
      turnId: 'run-1',
      type: 'message',
    });

    const frame = await nextFrame(reader);
    expect(frame).toContain('id: 1');
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
    expect(() => hub.attach(new RecordingTransport())).toThrow(
      /already has its internal transport/,
    );

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

  describe('steering, stopping and reading back', () => {
    test('hands over a steer as its own thing, not as a message', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      nox.hub.attach(transport);

      const response = await fetch(`${nox.url}/chat/conversations/${CONVERSATION}/steer`, {
        body: JSON.stringify({ content: [{ text: 'mejor no', type: 'text' }] }),
        headers: nox.headers,
        method: 'POST',
      });

      expect(response.status).toBe(202);
      expect(transport.steers).toHaveLength(1);
      expect(transport.steers[0]).toMatchObject({
        content: [{ text: 'mejor no', type: 'text' }],
        conversationId: CONVERSATION,
        senderId: nox.accountId,
      });
      // Steering intent stays explicit instead of being flattened into a message.
      expect(transport.messages).toHaveLength(0);
    });

    test('publishes the command catalog so a client never hardcodes one', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      transport.commands = [
        {
          description: 'Stops the agent.',
          name: 'stop',
          parameters: {
            properties: { scope: { enum: ['run', 'session'], type: 'string' } },
            type: 'object',
          },
        },
      ];
      nox.hub.attach(transport);

      const response = await fetch(`${nox.url}/chat/commands`, { headers: nox.headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ commands: transport.commands });
    });

    test('hands a command over with the arguments it was posted', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      nox.hub.attach(transport);

      const response = await fetch(`${nox.url}/chat/conversations/${CONVERSATION}/commands/stop`, {
        body: JSON.stringify({ scope: 'session' }),
        headers: nox.headers,
        method: 'POST',
      });

      // 202: accepted and queued, never finished. Holding the request open
      // across a run would make stopping one depend on it having stopped.
      expect(response.status).toBe(202);
      expect(transport.invocations[0]).toEqual({
        arguments: { scope: 'session' },
        command: 'stop',
        conversationId: CONVERSATION,
        senderId: nox.accountId,
      });
    });

    test('accepts a command with no arguments at all', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      nox.hub.attach(transport);

      const response = await fetch(`${nox.url}/chat/conversations/${CONVERSATION}/commands/stop`, {
        headers: nox.headers,
        method: 'POST',
      });

      // What an omitted argument means is the command's schema to say, not this
      // surface's to guess.
      expect(response.status).toBe(202);
      expect(transport.invocations[0]?.command).toBe('stop');
    });

    test('reports the two refusals a client can act on', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      nox.hub.attach(transport);

      transport.rejection = { reason: 'unknownCommand' };
      const unknown = await fetch(
        `${nox.url}/chat/conversations/${CONVERSATION}/commands/selfdestruct`,
        { headers: nox.headers, method: 'POST' },
      );

      transport.rejection = { detail: 'scope: invalid option', reason: 'invalidArguments' };
      const invalid = await fetch(`${nox.url}/chat/conversations/${CONVERSATION}/commands/stop`, {
        body: JSON.stringify({ scope: 'everything' }),
        headers: nox.headers,
        method: 'POST',
      });

      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'unknown_command' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        detail: 'scope: invalid option',
        error: 'invalid_arguments',
      });
    });

    test('reads a conversation back without speaking in it', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      transport.history = {
        agentId: 'assistant',
        conversationId: CONVERSATION,
        entries: [
          {
            at: '2026-01-01T00:00:00.000Z',
            content: [{ text: 'hola', type: 'text' }],
            messageId: 'm-1',
            mode: 'message',
            principal: { issuer: 'web', subject: 'wirhoss' },
            text: 'hola',
            type: 'userMessage',
          },
          {
            at: '2026-01-01T00:00:01.000Z',
            content: [{ text: 'hola mundo', type: 'text' }],
            messageId: 'm-2',
            text: 'hola mundo',
            type: 'message',
          },
        ],
        sessionId: 'session-1',
      };
      nox.hub.attach(transport);

      const response = await fetch(
        `${nox.url}/chat/conversations/${CONVERSATION}/history?limit=50`,
        { headers: nox.headers },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        entries: [{ type: 'userMessage' }, { type: 'message' }],
        sessionId: 'session-1',
      });
      expect(transport.reads[0]).toEqual({ conversationId: CONVERSATION, limit: 50 });
      // Reading is a GET because it is one: nothing was said in the chat.
      expect(transport.messages).toHaveLength(0);
    });

    test('answers that a chat nobody ever spoke in is not there', async () => {
      const nox = await chatNox();
      nox.hub.attach(new RecordingTransport());

      const response = await fetch(`${nox.url}/chat/conversations/${CONVERSATION}/history`, {
        headers: nox.headers,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'conversation_not_found' });
    });

    test('lists the conversations this surface carries', async () => {
      const nox = await chatNox();
      const transport = new RecordingTransport();
      transport.conversations = [
        {
          agentId: 'assistant',
          conversationId: CONVERSATION,
          sessionId: 'session-1',
          startedAt: '2026-01-01T00:00:00.000Z',
          state: 'closed',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ];
      nox.hub.attach(transport);

      const response = await fetch(`${nox.url}/chat/conversations`, { headers: nox.headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ conversations: transport.conversations });
    });

    test('refuses all four to whoever did not authenticate', async () => {
      const nox = await chatNox();
      nox.hub.attach(new RecordingTransport());
      const json = { 'content-type': 'application/json' };

      const responses = await Promise.all([
        fetch(`${nox.url}/chat/conversations`),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/history`),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/steer`, {
          body: JSON.stringify({ content: [{ text: 'mejor no', type: 'text' }] }),
          headers: json,
          method: 'POST',
        }),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/commands/stop`, {
          headers: json,
          method: 'POST',
        }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    });

    test('says the chat is unavailable when no broker claimed the surface', async () => {
      const nox = await chatNox();

      const responses = await Promise.all([
        fetch(`${nox.url}/chat/conversations`, { headers: nox.headers }),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/history`, { headers: nox.headers }),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/steer`, {
          body: JSON.stringify({ content: [{ text: 'mejor no', type: 'text' }] }),
          headers: nox.headers,
          method: 'POST',
        }),
        fetch(`${nox.url}/chat/conversations/${CONVERSATION}/commands/stop`, {
          headers: nox.headers,
          method: 'POST',
        }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503]);
    });
  });
});
