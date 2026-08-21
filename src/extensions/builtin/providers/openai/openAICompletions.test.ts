import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Session } from '../../../../agent/session';
import { Database } from '../../../../database/database';
import { isProviderError, type ProviderErrorCode } from '../../../../provider/error';
import { OpenAICompletions } from './openAICompletions';

import type { Message } from '../../../../agent/context/message';
import type { ModelConfig } from '../../../../provider/config';
import type { ProviderStreamEvent } from '../../../../provider/stream';
import type { Tool } from '../../../../tool/tool';

interface RecordedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
}

const realFetch = globalThis.fetch;
const requests: RecordedRequest[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  requests.length = 0;
});

/** Records every call and replies with `respond`, so tests assert on the wire. */
function stubFetch(respond: (request: RecordedRequest) => Promise<Response> | Response): void {
  // The adapter only ever passes string URLs, so the stub narrows to that.
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const request: RecordedRequest = { body, headers, url: input };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as unknown as typeof fetch;
}

function sse(...chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => JSON.stringify(chunk)), '[DONE]']
    .map((data) => `data: ${data}\n\n`)
    .join('');
  return new Response(body, { status: 200 });
}

function textDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}

function provider(overrides: Record<string, unknown> = {}): OpenAICompletions {
  return new OpenAICompletions({
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.test/v1/',
    defaultModel: 'gpt-test',
    maxRetries: 0,
    type: 'openai_completions',
    ...overrides,
  });
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Runs one completion and returns everything the stream emitted. */
async function run(
  instance: OpenAICompletions,
  history: Message[] = [],
  tools: Tool[] = [],
): Promise<ProviderStreamEvent[]> {
  return collect(instance.getMessageStream('be brief', history, tools));
}

function message(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  return { createdAt: new Date(0), messageId: partial.role, ...partial } as Message;
}

const echoTool: Tool = {
  description: 'Echoes a value back.',
  name: 'echo',
  parameters: z.object({ value: z.string().describe('What to echo.') }),
  prepare: () => ({
    run: () => Promise.resolve([{ text: 'echoed', type: 'text' as const }]),
    title: 'echo',
    type: 'immediate' as const,
  }),
};

describe('OpenAICompletions.fetchModelIds', () => {
  test('authenticates, normalizes the base URL, and keeps only string ids', async () => {
    stubFetch(() => Response.json({ data: [{ id: 'gpt-a' }, { id: 7 }, {}, { id: 'gpt-b' }] }));

    const ids = await provider().fetchModelIds();

    expect(ids).toEqual(['gpt-a', 'gpt-b']);
    expect(requests[0]?.url).toBe('https://api.example.test/v1/models');
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  test('sends no authorization header when no key is configured', async () => {
    stubFetch(() => Response.json({ data: [] }));

    await provider({ apiKey: undefined }).fetchModelIds();

    expect(requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe('OpenAICompletions request body', () => {
  test('streams with usage, names the model, and leads with the system prompt', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [message({ content: [{ text: 'hello', type: 'text' }], role: 'user' })]);

    const body = requests[0]?.body ?? {};
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      { content: 'hello', role: 'user' },
    ]);
  });

  test('renders tools as JSON schema functions', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [], [echoTool]);

    expect(requests[0]?.body.tools).toEqual([
      {
        function: {
          description: 'Echoes a value back.',
          name: 'echo',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: { value: { description: 'What to echo.', type: 'string' } },
            required: ['value'],
            type: 'object',
          },
        },
        type: 'function',
      },
    ]);
  });

  test('omits sampling parameters that were never configured', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider());

    const body = requests[0]?.body ?? {};
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('tools');
  });

  test('fails when no model is configured at all', async () => {
    stubFetch(() => sse(textDelta('hi')));

    const events = await run(provider({ defaultModel: undefined }));

    expect(events.at(-1)?.type).toBe('error');
  });
});

describe('OpenAICompletions message mapping', () => {
  test('keeps images as content parts and plain turns as strings', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        content: [
          { text: 'look', type: 'text' },
          { source: { type: 'url', url: 'https://img.test/a.png' }, type: 'image' },
        ],
        role: 'user',
      }),
    ]);

    expect((requests[0]?.body.messages as unknown[])[1]).toEqual({
      content: [
        { text: 'look', type: 'text' },
        { image_url: { url: 'https://img.test/a.png' }, type: 'image_url' },
      ],
      role: 'user',
    });
  });

  test('marks a compacted turn as reference material rather than an instruction', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        compactedMessageIds: ['a'],
        content: [{ text: 'we discussed X', type: 'text' }],
        role: 'compacted',
      }),
    ]);

    expect((requests[0]?.body.messages as { content: string; role: string }[])[1]).toEqual({
      content: '[conversation summary]\nwe discussed X',
      role: 'user',
    });
  });

  test('rides a fold onto the assistant turn it replaced traffic for', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'working', type: 'text' }], role: 'assistant' }),
      message({
        anchorMessageId: 'assistant',
        content: [{ text: '[folded 3 calls]', type: 'text' }],
        foldedMessageIds: ['x'],
        role: 'folded',
      }),
    ]);

    const messages = requests[0]?.body.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ content: 'working\n[folded 3 calls]', role: 'assistant' });
  });

  test('drops reasoning instead of replaying it as assistant text', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'let me think', type: 'text' }], role: 'reasoning' }),
    ]);

    expect(requests[0]?.body.messages).toEqual([{ content: 'be brief', role: 'system' }]);
  });

  test('attaches a tool call to the assistant turn and answers it as a tool message', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'calling', type: 'text' }], role: 'assistant' }),
      message({ arguments: { value: 'x' }, name: 'echo', role: 'toolCall', trackId: 'call_1' }),
      message({
        execution: 'immediate',
        name: 'echo',
        response: [{ text: 'echoed', type: 'text' }],
        role: 'toolResponse',
        trackId: 'call_1',
      }),
    ]);

    expect(requests[0]?.body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      {
        content: 'calling',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{"value":"x"}', name: 'echo' },
            id: 'call_1',
            type: 'function',
          },
        ],
      },
      { content: 'echoed', role: 'tool', tool_call_id: 'call_1' },
    ]);
  });

  test('rides a fold onto a textless assistant anchor after reasoning', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'do it', type: 'text' }], role: 'user' }),
      message({ content: [{ text: 'thinking', type: 'text' }], role: 'reasoning' }),
      // ProviderStream materializes this turn when a model emits tool calls
      // without visible assistant text. The fold remains assistant-anchored.
      message({ content: [], messageId: 'anchor', role: 'assistant' }),
      message({
        anchorMessageId: 'anchor',
        content: [{ text: '[folded 2 calls]', type: 'text' }],
        foldedMessageIds: ['c1', 'r1'],
        role: 'folded',
      }),
    ]);

    expect(requests[0]?.body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      { content: 'do it', role: 'user' },
      { content: '[folded 2 calls]', role: 'assistant' },
    ]);
  });

  test('surfaces a late deferred result as correlated user content', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        execution: 'deferredResult',
        name: 'build',
        response: [{ text: 'exit 0', type: 'text' }],
        role: 'toolResponse',
        trackId: 'call_9',
      }),
    ]);

    expect((requests[0]?.body.messages as { content: string; role: string }[])[1]).toEqual({
      content: '[deferred result for build (call_9)]\nexit 0',
      role: 'user',
    });
  });
});

describe('OpenAICompletions session regression', () => {
  test('persists and replays a folded tool-only reasoning turn into the next request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-fold-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    const model: ModelConfig = { modelId: 'gpt-test', type: 'text' };
    const bulkyEcho: Tool = {
      ...echoTool,
      prepare: () => ({
        run: () => Promise.resolve([{ text: 'echoed '.repeat(1000), type: 'text' as const }]),
        title: 'echo',
        type: 'immediate' as const,
      }),
    };

    stubFetch(() => {
      switch (requests.length) {
        case 1:
          return sse(
            { choices: [{ delta: { reasoning_content: 'thinking before the call' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: '{"value":"x"}', name: 'echo' },
                        id: 'call_1',
                        index: 0,
                      },
                    ],
                  },
                },
              ],
            },
          );
        case 2:
          return sse(
            { choices: [{ delta: { reasoning_content: 'checking the result' } }] },
            textDelta('first turn done'),
          );
        case 3:
          return sse(textDelta('second turn done'));
        default:
          throw new Error(`Unexpected request ${String(requests.length)}.`);
      }
    });

    try {
      const instance = provider();
      const session = await Session.open(database, instance, model, {
        agentId: 'test',
        context: { foldMinReductionRatio: 0.01, tools: { echo: bulkyEcho } },
        sessionId: 'folded-reasoning-turn',
        systemPrompt: 'be brief',
      });

      session.send('use echo');
      await session.idle;
      await session.stop();

      // ProviderStream inserted this assistant before the call, so the request
      // answering the tool result has a valid assistant/tool/tool sequence.
      const secondWire = requests[1]?.body.messages as { content: null | string; role: string }[];
      expect(secondWire.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'tool']);
      expect(secondWire[2]).toMatchObject({ content: null, role: 'assistant' });

      // Reopen from storage, not from the live Context. The fold and its
      // synthetic assistant anchor must both survive and reconnect by ID.
      const resumed = await Session.open(database, instance, model, {
        agentId: 'test',
        context: { foldMinReductionRatio: 0.01, tools: { echo: bulkyEcho } },
        sessionId: session.sessionId,
        systemPrompt: 'be brief',
      });
      const transcript = resumed.getTranscript();
      const anchor = transcript.find(
        (entry) => entry.role === 'assistant' && entry.content.length === 0,
      );
      const fold = transcript.find((entry) => entry.role === 'folded');

      expect(anchor?.role).toBe('assistant');
      expect(fold?.role === 'folded' ? fold.anchorMessageId : undefined).toBe(anchor?.messageId);

      resumed.send('what happened?');
      await resumed.idle;
      await resumed.stop();

      const replayedWire = requests[2]?.body.messages as { content: null | string; role: string }[];
      expect(
        replayedWire.some(
          (entry) =>
            entry.role === 'assistant' &&
            entry.content?.includes('-----Folded tool calls-----') === true,
        ),
      ).toBeTrue();
      expect(JSON.stringify(replayedWire)).not.toContain('thinking before the call');
      expect(JSON.stringify(replayedWire)).not.toContain('checking the result');
      expect(replayedWire.at(-1)).toEqual({ content: 'what happened?', role: 'user' });
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may retain the SQLite handle briefly; the directory is disposable.
      }
    }
  });
});

describe('OpenAICompletions streaming', () => {
  test('emits reasoning and text fragments and reports usage', async () => {
    stubFetch(() =>
      sse(
        { choices: [{ delta: { reasoning_content: 'thinking' } }] },
        textDelta('he'),
        textDelta('llo'),
        {
          choices: [],
          usage: {
            completion_tokens: 5,
            prompt_tokens: 11,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ),
    );

    const events = await run(provider());

    expect(
      events.filter((event) => event.type === 'textFragment').map((event) => event.text),
    ).toEqual(['he', 'llo']);
    expect(events.filter((event) => event.type === 'reasoningFragment')).toHaveLength(1);

    const end = events.at(-1);
    expect(end?.type).toBe('end');
    expect(end?.type === 'end' ? end.usage : undefined).toEqual({
      cacheReadTokens: 8,
      inputTokens: 11,
      outputTokens: 5,
    });
  });

  test('accumulates a tool call split across chunks', async () => {
    stubFetch(() =>
      sse(
        {
          choices: [
            { delta: { tool_calls: [{ function: { name: 'ec' }, id: 'call_', index: 0 }] } },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ function: { name: 'ho' }, id: '1', index: 0 }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"val' }, index: 0 }] } }] },
        {
          choices: [{ delta: { tool_calls: [{ function: { arguments: 'ue":"x"}' }, index: 0 }] } }],
        },
      ),
    );

    const events = await run(provider());
    const toolCall = events.find((event) => event.type === 'toolCall');

    expect(toolCall?.type === 'toolCall' ? toolCall.toolCall : undefined).toMatchObject({
      arguments: { value: 'x' },
      name: 'echo',
      role: 'toolCall',
      trackId: 'call_1',
    });
  });

  test('reads a final data line that arrived without a trailing [DONE]', async () => {
    stubFetch(() => new Response(`data: ${JSON.stringify(textDelta('tail'))}`, { status: 200 }));

    const events = await run(provider());

    expect(
      events.filter((event) => event.type === 'textFragment').map((event) => event.text),
    ).toEqual(['tail']);
  });

  test('fails a tool call whose arguments are not valid JSON', async () => {
    stubFetch(() =>
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ function: { arguments: '{oops', name: 'echo' }, id: 'c1', index: 0 }],
            },
          },
        ],
      }),
    );

    const events = await run(provider());

    expect(events.at(-1)?.type).toBe('error');
  });
});

describe('OpenAICompletions error classification', () => {
  const cases: [label: string, status: number, body: unknown, code: ProviderErrorCode][] = [
    [
      'authentication',
      401,
      { error: { code: 'invalid_api_key', message: 'bad key' } },
      'authentication',
    ],
    ['rate limit', 429, { error: { message: 'slow down' } }, 'rate_limit'],
    [
      'context limit',
      400,
      { error: { message: 'This model maximum context length is 8192 tokens' } },
      'context_limit',
    ],
    [
      'usage limit',
      400,
      { error: { code: 'insufficient_quota', message: 'no credit' } },
      'usage_limit',
    ],
    ['invalid request', 422, { error: { message: 'bad field' } }, 'invalid_request'],
    ['unclassified', 500, { error: { message: 'boom' } }, 'provider_error'],
  ];

  for (const [label, status, body, code] of cases) {
    test(`classifies ${label} responses as ${code}`, async () => {
      stubFetch(() => Response.json(body, { status }));

      const events = await run(provider());
      const failure = events.at(-1);

      expect(failure?.type).toBe('error');
      expect(failure?.type === 'error' ? failure.error.code : undefined).toBe(code);
      expect(failure?.type === 'error' ? failure.error.provider : undefined).toBe(
        'openai_completions',
      );
    });
  }

  test('classifies a failure before response headers as a connection error', async () => {
    stubFetch(() => {
      throw new TypeError('socket hang up');
    });

    const events = await run(provider());
    const failure = events.at(-1);

    expect(failure?.type === 'error' && isProviderError(failure.error)).toBe(true);
    expect(failure?.type === 'error' ? failure.error.code : undefined).toBe('connection');
  });

  test('reports a stream error carried inside the event payload', async () => {
    stubFetch(() => sse({ error: { message: 'upstream exploded', type: 'server_error' } }));

    const events = await run(provider());
    const failure = events.at(-1);

    expect(failure?.type).toBe('error');
    expect(failure?.type === 'error' ? failure.error.message : '').toContain('upstream exploded');
  });
});
