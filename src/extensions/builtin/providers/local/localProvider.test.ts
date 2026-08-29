import { isChatCapable, isEmbeddingCapable } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { LocalProvider } from './localProvider';

import type { WorkerLike } from './modelHost';
import type { HostMessage, WorkerMessage } from './protocol';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

/** Streams back one chunk per word of the last thing it was told. */
function echoWorker(): { seen: HostMessage[]; spawn: () => WorkerLike } {
  const seen: HostMessage[] = [];
  const spawn = (): WorkerLike => {
    let onMessage: ((message: WorkerMessage) => void) | undefined;
    return {
      on(event: string, listener: (payload: never) => void): void {
        if (event === 'message') onMessage = listener as (message: WorkerMessage) => void;
      },
      postMessage(message: HostMessage): void {
        seen.push(message);
        if (message.kind !== 'call' || message.call.kind !== 'generate') return;
        const said = message.call.messages.at(-1)?.text ?? '';
        for (const word of said.split(' ')) {
          onMessage?.({ id: message.id, kind: 'chunk', text: `${word} ` });
        }
        onMessage?.({
          id: message.id,
          kind: 'settled',
          value: { decodeMs: 10, generatedTokens: 3, loadMs: 0, promptTokens: 7, ttftMs: 5 },
        });
      },
      terminate: () => Promise.resolve(0),
    };
  };
  return { seen, spawn };
}

function provider(spawn: () => WorkerLike): LocalProvider {
  return new LocalProvider(
    LocalProvider.configSchema.parse({
      llm: { enabled: true, model: 'test/model' },
      type: 'local',
    }),
    { spawn },
  );
}

function userMessage(text: string) {
  return {
    content: [{ text, type: 'text' as const }],
    createdAt: new Date(),
    messageId: 'm1',
    origin: {
      principal: { issuer: 'test', subject: 'esteban' },
      transport: 'test',
      transportMessageId: 'm1',
    },
    role: 'user' as const,
  };
}

describe('the local provider configuration', () => {
  test('does not let the singleton seeder turn an absent choice into a configured provider', () => {
    expect(LocalProvider.configSchema.safeParse({ type: 'local' }).success).toBeFalse();
  });

  test('refuses metadata for models the local engine did not enable', () => {
    const parsed = LocalProvider.configSchema.safeParse({
      llm: { enabled: true, model: 'test/chat' },
      modelConfigs: [{ modelId: 'test/not-loaded' }],
      type: 'local',
    });

    expect(parsed.success).toBeFalse();
  });

  test('reports only the capabilities whose models this instance enabled', async () => {
    const { spawn } = echoWorker();
    const chatOnly = provider(spawn);
    const embeddingOnly = new LocalProvider(
      LocalProvider.configSchema.parse({
        embedding: { dimensions: 4, enabled: true, model: 'test/embedding' },
        type: 'local',
      }),
      { spawn },
    );

    expect(isChatCapable(chatOnly)).toBeTrue();
    expect(isEmbeddingCapable(chatOnly)).toBeFalse();
    expect(isChatCapable(embeddingOnly)).toBeFalse();
    expect(isEmbeddingCapable(embeddingOnly)).toBeTrue();
    expect(await chatOnly.fetchModelIds()).toEqual(['test/model']);
    expect(await embeddingOnly.fetchModelIds()).toEqual(['test/embedding']);
  });
});

describe('the local chat provider', () => {
  test('delivers the answer as it is produced rather than when it is finished', async () => {
    const { spawn } = echoWorker();
    const stream = provider(spawn).getMessageStream('be exact', [userMessage('one two three')], []);

    const fragments: string[] = [];
    for await (const event of stream) {
      if (event.type === 'textFragment') fragments.push(event.text);
    }

    expect(fragments).toEqual(['one ', 'two ', 'three ']);
  });

  test('sends only original speech across the thread boundary', async () => {
    const { seen, spawn } = echoWorker();

    for await (const _event of provider(spawn).getMessageStream(
      'be exact',
      [userMessage('hi')],
      [],
    ));

    const call = seen.find((message) => message.kind === 'call');
    expect(call?.kind === 'call' && call.call).toMatchObject({
      messages: [{ role: 'user', text: 'hi' }],
      systemPrompt: 'be exact',
    });
  });

  test('refuses tools instead of accepting them and never calling any', async () => {
    const { spawn } = echoWorker();
    const tool = { description: 'nope', name: 'doThing' } as never;
    const stream = provider(spawn).getMessageStream('be exact', [userMessage('hi')], [tool]);

    const error = await rejection(stream.completed);

    // Accepting them silently would read as an agent that chose not to act.
    expect(String(error)).toContain('cannot call tools');
  });
});
