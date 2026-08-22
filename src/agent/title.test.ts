import { describe, expect, test } from 'bun:test';

import { ChatProvider } from '../provider/provider';
import { testOrigin } from '../testFixtures';
import { generateTitle, MAX_TITLE_CHARS, TITLE_PROMPT } from './title';

import type { TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool } from '../tool/tool';
import type { AssistantMessage, Message, UserMessage } from './context/message';

/** Answers every request with one fixed line, and remembers what it was asked. */
class AnsweringProvider extends ChatProvider {
  public readonly prompts: string[] = [];
  public readonly requests: Message[][] = [];

  readonly #answer: string;

  constructor(answer: string) {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
    this.#answer = answer;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.prompts.push(systemPrompt);
    this.requests.push([...messageHistory]);
    yield { text: this.#answer, type: 'textFragment' };
    yield { type: 'end' };
  }
}

function said(text: string): UserMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    messageId: `user-${text}`,
    origin: testOrigin(),
    role: 'user',
  };
}

function replied(text: string): AssistantMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    messageId: `assistant-${text}`,
    role: 'assistant',
  };
}

const OPENING: Message[] = [
  said('los timeouts de Redis en la capa de caché'),
  replied('REDIS_TIMEOUT_MS está en config/cache.yaml.'),
];

describe('naming a session', () => {
  test('asks the model under the titling prompt, not the agent’s', async () => {
    const provider = new AnsweringProvider('Timeouts de Redis en cache.yaml');

    const title = await generateTitle({ history: OPENING, provider });

    expect(title).toBe('Timeouts de Redis en cache.yaml');
    expect(provider.prompts).toEqual([TITLE_PROMPT]);
    // One request, carrying the opening as prose. The tool traffic of a first
    // exchange never reaches it: a call handed over without its result is a
    // malformed request, and a title is read off what was said either way.
    expect(provider.requests).toHaveLength(1);
    const [request] = provider.requests;
    expect(request).toHaveLength(1);
    const sent = request?.[0];
    const text =
      sent?.role === 'user' ? (sent.content[0]?.type === 'text' ? sent.content[0].text : '') : '';
    expect(text).toContain('los timeouts de Redis en la capa de caché');
    expect(text).toContain('REDIS_TIMEOUT_MS está en config/cache.yaml.');
  });

  test('strips what models wrap a title in', async () => {
    const provider = new AnsweringProvider('Title: "Timeouts de Redis".\n\nHope that helps!');

    expect(await generateTitle({ history: OPENING, provider })).toBe('Timeouts de Redis');
  });

  test('cuts an overlong title on a word boundary', async () => {
    const provider = new AnsweringProvider(
      'Una explicación larguísima de por qué los timeouts de Redis se disparan bajo carga',
    );

    const title = await generateTitle({ history: OPENING, provider });

    expect(title?.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1);
    expect(title?.endsWith('…')).toBeTrue();
    expect(title).not.toContain('  ');
  });

  test('leaves a session unnamed when the opening is not about anything', async () => {
    const provider = new AnsweringProvider('UNTITLED');

    expect(
      await generateTitle({ history: [said('hola'), replied('¡Hola!')], provider }),
    ).toBeUndefined();
  });

  test('never asks about an opening nobody spoke in', async () => {
    const provider = new AnsweringProvider('Algo');

    // A transcript that starts with the agent — a deferred result waking it —
    // has no subject yet, and a name invented for one is worse than no name.
    expect(
      await generateTitle({ history: [replied('sigo trabajando')], provider }),
    ).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
  });
});
