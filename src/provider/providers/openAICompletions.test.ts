import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { ProviderError } from '../error';

import { OpenAICompletions } from './openAICompletions';

import type { Tool } from '../../tool';
import type { Message } from '../message';
import type { ProviderStreamEvent } from '../stream';

const originalFetch = globalThis.fetch;

/** Fixed history timestamps keep assertions independent of the stream clock. */
function at(second: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenAICompletions', () => {
  test('lists model ids with authentication', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(input).toBe('https://api.openai.test/v1/models');
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret' });

      return Response.json({
        data: [{ id: 'gpt-a' }, { id: 7 }, { id: 'gpt-b' }],
      });
    }) as typeof fetch;

    const provider = new OpenAICompletions({
      apiKey: 'secret',
      baseUrl: 'https://api.openai.test/v1/',
      type: 'openai_completions',
    });

    expect(await provider.fetchModelIds()).toEqual(['gpt-a', 'gpt-b']);
  });

  test('renders a fold onto the assistant turn it belongs to', async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = new OpenAICompletions({
      apiKey: 'secret',
      baseUrl: 'https://api.openai.test/v1',
      defaultModel: 'gpt-test',
      type: 'openai_completions',
    });

    const history: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'I\'ll check.' }], createdAt: at(0), messageId: 'a0' },
      {
        anchorMessageId: 'a0',
        content: [{ type: 'text', text: '-----folded-----' }],
        createdAt: at(1),
        foldedMessageIds: ['tc1', 'tr1'],
        messageId: 'fold_1',
        role: 'folded',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'It is sunny.' }], createdAt: at(2), messageId: 'a1' },
    ];

    const stream = provider.getMessageStream('Be helpful', history, []);
    await stream.completed;

    // The fold never becomes a turn of its own: a bare assistant/assistant pair
    // would break role alternation on providers that enforce it.
    expect(requestBody?.messages).toEqual([
      { content: 'Be helpful', role: 'system' },
      { content: 'I\'ll check.\n-----folded-----', role: 'assistant' },
      { content: 'It is sunny.', role: 'assistant' },
    ]);
  });

  test('maps messages and tools, then streams text, tool calls, and usage', async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      expect(input).toBe('https://api.openai.test/v1/chat/completions');
      expect(init?.method).toBe('POST');
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      const sse = [
        'data: {"choices":[{"delta":{"reasoning_content":"Think "}}]}',
        'data: {"choices":[{"delta":{"reasoning":"carefully"}}]}',
        'data: {"choices":[{"delta":{"content":"Hello "}}]}',
        'data: {"choices":[{"delta":{"content":"there"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"San José\\"}"}}]}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}',
        'data: [DONE]',
        '',
      ].join('\n\n');

      return new Response(sse, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = new OpenAICompletions({
      apiKey: 'secret',
      baseUrl: 'https://api.openai.test/v1',
      defaultModel: 'gpt-test',
      modelConfigs: [{
        maxTokens: 42,
        modelId: 'gpt-test',
        temperature: 0.2,
        type: 'text',
      }],
      type: 'openai_completions',
    });
    const history: Message[] = [
      {
        content: [{ type: 'text', text: 'Earlier we set up the trip.' }],
        createdAt: at(0),
        messageId: 'message_0',
        compactedMessageIds: ['omitted_message'],
        role: 'compacted',
      },
      { role: 'user', content: [{ type: 'text', text: 'Previous question' }], createdAt: at(1), messageId: 'message_1' },
      { role: 'assistant', content: [{ type: 'text', text: 'I\'ll check.' }], createdAt: at(2), messageId: 'message_2' },
      { role: 'reasoning', content: [{ type: 'text', text: 'Internal prior reasoning' }], createdAt: at(3), messageId: 'message_3' },
      {
        arguments: { city: 'Cartago' },
        createdAt: at(4),
        messageId: 'message_4',
        name: 'weather',
        role: 'toolCall',
        trackId: 'previous_call',
      },
      {
        createdAt: at(5),
        execution: 'immediate',
        messageId: 'message_5',
        name: 'weather',
        response: [{ type: 'text', text: 'Sunny' }],
        role: 'toolResponse',
        trackId: 'previous_call',
      },
      {
        content: [{
          source: { type: 'url', url: 'https://example.com/image.png' },
          type: 'image',
        }],
        createdAt: at(6),
        messageId: 'message_6',
        role: 'user',
      },
    ];
    const tools: Tool[] = [{
      description: 'Get the weather',
      executionType: 'immediate',
      name: 'weather',
      parameters: z.object({ city: z.string() }),
      prepare: () => ({
        run: async () => [{ text: 'Sunny', type: 'text' }],
        title: 'Get the weather',
        type: 'immediate',
      }),
    }];

    const stream = provider.getMessageStream('Be helpful', history, tools, {
      topP: 0.8,
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(requestBody).toMatchObject({
      max_completion_tokens: 42,
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.8,
    });
    expect(requestBody?.messages).toEqual([
      { content: 'Be helpful', role: 'system' },
      {
        content: '[conversation summary]\nEarlier we set up the trip.',
        role: 'user',
      },
      { content: 'Previous question', role: 'user' },
      {
        content: 'I\'ll check.',
        role: 'assistant',
        tool_calls: [{
          function: {
            arguments: '{"city":"Cartago"}',
            name: 'weather',
          },
          id: 'previous_call',
          type: 'function',
        }],
      },
      { content: 'Sunny', role: 'tool', tool_call_id: 'previous_call' },
      {
        content: [{
          image_url: { url: 'https://example.com/image.png' },
          type: 'image_url',
        }],
        role: 'user',
      },
    ]);
    expect(requestBody?.tools).toEqual([{
      function: {
        description: 'Get the weather',
        name: 'weather',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          properties: { city: { type: 'string' } },
          required: ['city'],
          type: 'object',
        },
      },
      type: 'function',
    }]);
    expect(events).toEqual([
      { text: 'Think ', type: 'reasoningFragment' },
      { text: 'carefully', type: 'reasoningFragment' },
      { text: 'Hello ', type: 'textFragment' },
      { text: 'there', type: 'textFragment' },
      {
        toolCall: {
          arguments: { city: 'San José' },
          createdAt: expect.any(Date),
          messageId: expect.any(String),
          name: 'weather',
          role: 'toolCall',
          trackId: 'call_1',
        },
        type: 'toolCall',
      },
      {
        aborted: false,
        messages: [
          {
            content: [{ text: 'Think carefully', type: 'text' }],
            createdAt: expect.any(Date),
            messageId: expect.any(String),
            role: 'reasoning',
          },
          {
            content: [{ text: 'Hello there', type: 'text' }],
            createdAt: expect.any(Date),
            messageId: expect.any(String),
            role: 'assistant',
          },
          {
            arguments: { city: 'San José' },
            createdAt: expect.any(Date),
            messageId: expect.any(String),
            name: 'weather',
            role: 'toolCall',
            trackId: 'call_1',
          },
        ],
        type: 'end',
        usage: {
          cacheReadTokens: 3,
          inputTokens: 12,
          outputTokens: 4,
        },
      },
    ]);
    const completed = await stream.completed;
    expect(completed).toEqual([
      {
        content: [{ text: 'Think carefully', type: 'text' }],
        createdAt: expect.any(Date),
        messageId: expect.any(String),
        role: 'reasoning',
      },
      {
        content: [{ text: 'Hello there', type: 'text' }],
        createdAt: expect.any(Date),
        messageId: expect.any(String),
        role: 'assistant',
      },
      {
        arguments: { city: 'San José' },
        createdAt: expect.any(Date),
        messageId: expect.any(String),
        name: 'weather',
        role: 'toolCall',
        trackId: 'call_1',
      },
    ]);
    // Reasoning happened before the answer, and the answer before the call.
    const stamps = completed.map((message) => message.createdAt.getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test('surfaces API errors through the provider stream', async () => {
    globalThis.fetch = (async () => new Response(
      '{"error":{"code":"invalid_api_key","message":"bad key","type":"invalid_request_error"}}',
      { status: 401 },
    )) as unknown as typeof fetch;

    const provider = new OpenAICompletions({
      baseUrl: 'https://api.openai.test/v1',
      defaultModel: 'gpt-test',
      type: 'openai_completions',
    });
    const stream = provider.getMessageStream('', [], []);

    const events: ProviderStreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].error).toBeInstanceOf(ProviderError);
      expect(events[0].error.code).toBe('authentication');
      expect(events[0].error.providerCode).toBe('invalid_api_key');
      expect(events[0].error.status).toBe(401);
      expect(events[0].error.message).toContain('bad key');
    }
    await expect(stream.completed).rejects.toThrow('401');
  });

  test('classifies context, quota, and rate limits independently', async () => {
    const scenarios = [
      {
        body: { error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } },
        expectedCode: 'context_limit',
        status: 400,
      },
      {
        body: { error: { code: 'insufficient_quota', message: 'usage limit reached' } },
        expectedCode: 'usage_limit',
        status: 429,
      },
      {
        body: { error: { code: 'rate_limit_exceeded', message: 'too many requests' } },
        expectedCode: 'rate_limit',
        status: 429,
      },
    ] as const;

    for (const scenario of scenarios) {
      globalThis.fetch = (async () => Response.json(scenario.body, {
        status: scenario.status,
      })) as unknown as typeof fetch;

      const provider = new OpenAICompletions({
        baseUrl: 'https://api.openai.test/v1',
        defaultModel: 'gpt-test',
        type: 'openai_completions',
      });
      const stream = provider.getMessageStream('', [], []);
      const events: ProviderStreamEvent[] = [];
      for await (const event of stream) events.push(event);

      const event = events[0];
      expect(event?.type).toBe('error');
      if (event?.type !== 'error') throw new Error('Expected a provider error event');
      expect(event.error.code).toBe(scenario.expectedCode);
      expect(event.error.providerCode).toBe(scenario.body.error.code);
      expect(event.error.status).toBe(scenario.status);
      await expect(stream.completed).rejects.toBe(event.error);
    }
  });

  test('classifies failures before response headers as connection errors', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Unable to connect');
    }) as unknown as typeof fetch;

    const provider = new OpenAICompletions({
      baseUrl: 'https://api.openai.test/v1',
      defaultModel: 'gpt-test',
      maxRetries: 0,
      type: 'openai_completions',
    });
    const stream = provider.getMessageStream('', [], []);
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream) events.push(event);

    const event = events[0];
    expect(event?.type).toBe('error');
    if (event?.type !== 'error') throw new Error('Expected a provider error event');
    expect(event.error.code).toBe('connection');
    expect(event.error.provider).toBe('openai_completions');
    expect(event.error.cause).toBeInstanceOf(TypeError);
    await expect(stream.completed).rejects.toBe(event.error);
  });
});
