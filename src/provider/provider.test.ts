import {
  ChatProvider,
  type Message,
  ProviderError,
  type ProviderSourceEvent,
  type ProviderStreamEvent,
  type TextGenerateOptions,
  type Tool,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

type Attempt = () => AsyncIterable<ProviderSourceEvent>;

/** Fails or succeeds on command, so the retry loop itself is what is measured. */
class ScriptedProvider extends ChatProvider {
  public attempts = 0;

  readonly #script: Attempt[];

  constructor(script: Attempt[], maxRetries = 2, retryDelayMs = 1, maxRetryDelayMs = 30_000) {
    super({ maxRetries, maxRetryDelayMs, retryDelayMs });
    this.#script = [...script];
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.attempts += 1;
    const next = this.#script.shift();
    if (next === undefined) throw new Error('Provider ran out of scripted attempts.');
    yield* next();
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* fails(code: 'authentication' | 'connection', message = 'boom') {
  yield* [];
  throw new ProviderError(code, message);
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* partialThenFails(text: string) {
  yield { text, type: 'textFragment' as const };
  throw new ProviderError('connection', 'dropped mid-stream');
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* succeeds(text: string) {
  yield { text, type: 'textFragment' as const };
  yield { type: 'end' as const };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* artifactBetweenText() {
  yield { text: 'download ', type: 'textFragment' as const };
  yield {
    artifact: {
      artifactId: 'art_12345678',
      filename: 'answer.txt',
      mediaType: 'text/plain',
      size: 6,
    },
    type: 'artifact' as const,
  };
  yield { text: 'ready', type: 'textFragment' as const };
  yield { type: 'end' as const };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* reasonsThenCallsTool() {
  yield { text: 'thinking', type: 'reasoningFragment' as const };
  yield {
    toolCall: {
      arguments: { value: 'x' },
      name: 'echo',
      role: 'toolCall' as const,
      trackId: 'call-1',
    },
    type: 'toolCall' as const,
  };
  yield { type: 'end' as const };
}

async function collect(provider: ChatProvider): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.getMessageStream('system', [], [])) events.push(event);
  return events;
}

describe('ChatProvider output normalization', () => {
  test('materializes text and durable artifact references in provider order', async () => {
    const provider = new ScriptedProvider([artifactBetweenText]);
    const stream = provider.getMessageStream('system', [], []);
    for await (const _event of stream) {
      // Artifact output is discrete and appears in the settled assistant message.
    }

    expect(await stream.completed).toMatchObject([
      {
        content: [
          { text: 'download ', type: 'text' },
          {
            artifact: { artifactId: 'art_12345678', filename: 'answer.txt' },
            type: 'artifact',
          },
          { text: 'ready', type: 'text' },
        ],
        role: 'assistant',
      },
    ]);
  });

  test('materializes an assistant anchor for reasoning followed by tool calls', async () => {
    const provider = new ScriptedProvider([reasonsThenCallsTool]);
    const stream = provider.getMessageStream('system', [], []);
    for await (const _event of stream) {
      // Drain the stream so completed contains the normalized turn.
    }

    const messages = await stream.completed;

    expect(messages.map((message) => message.role)).toEqual(['reasoning', 'assistant', 'toolCall']);
    expect(messages[1]).toMatchObject({ content: [], role: 'assistant' });
  });
});

describe('ChatProvider retries', () => {
  test('retries a connection failure and reports each attempt with a growing delay', async () => {
    const provider = new ScriptedProvider([
      () => fails('connection'),
      () => fails('connection'),
      () => succeeds('finally'),
    ]);

    const events = await collect(provider);
    const retries = events.filter((event) => event.type === 'retry');

    expect(provider.attempts).toBe(3);
    expect(retries.map((event) => event.attempt)).toEqual([1, 2]);
    // Exponential from retryDelayMs, so a struggling provider is not hammered.
    expect(retries.map((event) => event.delayMs)).toEqual([1, 2]);
    expect(retries.map((event) => event.resetOutput)).toEqual([true, true]);
    expect(events.at(-1)?.type).toBe('end');
  });

  test('caps exponential backoff at the provider-configured maximum', async () => {
    const provider = new ScriptedProvider(
      [() => fails('connection'), () => fails('connection'), () => succeeds('finally')],
      2,
      2,
      3,
    );

    const events = await collect(provider);
    const retries = events.filter((event) => event.type === 'retry');

    expect(retries.map((event) => event.delayMs)).toEqual([2, 3]);
  });

  test('discards output produced before a retry instead of duplicating it', async () => {
    const provider = new ScriptedProvider([
      () => partialThenFails('half a sen'),
      () => succeeds('a whole sentence'),
    ]);

    const stream = provider.getMessageStream('system', [], []);
    for await (const _event of stream) {
      // Draining is what settles `completed`.
    }
    const messages = await stream.completed;
    const text = messages
      .flatMap((message) => (message.role === 'assistant' ? message.content : []))
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');

    // The fragment from the failed attempt reached subscribers live, but the
    // messages the session keeps must contain the successful attempt alone.
    expect(text).toBe('a whole sentence');
    expect(text).not.toContain('half a sen');
  });

  test('gives up after maxRetries and fails with the provider error', async () => {
    const provider = new ScriptedProvider([
      () => fails('connection', 'refused'),
      () => fails('connection', 'refused'),
      () => fails('connection', 'refused'),
    ]);

    const events = await collect(provider);
    const failure = events.at(-1);

    // maxRetries is the number of *re*-tries, so three attempts in total.
    expect(provider.attempts).toBe(3);
    expect(failure?.type).toBe('error');
    expect(failure?.type === 'error' ? failure.error.code : undefined).toBe('connection');
    expect(failure?.type === 'error' ? failure.error.message : '').toContain('refused');
  });

  test('does not retry a failure that retrying cannot fix', async () => {
    const provider = new ScriptedProvider([() => fails('authentication', 'bad key')]);

    const events = await collect(provider);

    expect(provider.attempts).toBe(1);
    expect(events.some((event) => event.type === 'retry')).toBeFalse();
    expect(events.at(-1)?.type).toBe('error');
  });

  test('an abort during the backoff ends the stream instead of waiting it out', async () => {
    const provider = new ScriptedProvider(
      [() => fails('connection'), () => succeeds('never reached')],
      // Long enough that finishing the wait would hang the test.
      2,
    );
    const controller = new AbortController();

    const stream = provider.getMessageStream('system', [], [], { signal: controller.signal });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'retry') controller.abort();
    }

    expect(events.some((event) => event.type === 'retry')).toBeTrue();
    expect(events.at(-1)?.type).toBe('end');
    expect(events.at(-1)?.type === 'end' ? events.at(-1) : undefined).toMatchObject({
      aborted: true,
    });
  });
});
