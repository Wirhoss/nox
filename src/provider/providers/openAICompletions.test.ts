import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { OpenAICompletions } from './openAICompletions';

import type { Tool } from '../../tool';
import type { Message } from '../message';
import type { ProviderStreamEvent } from '../stream';

const originalFetch = globalThis.fetch;

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

  test('maps messages and tools, then streams text, tool calls, and usage', async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      expect(input).toBe('https://api.openai.test/v1/chat/completions');
      expect(init?.method).toBe('POST');
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      const sse = [
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
      { role: 'user', content: [{ type: 'text', text: 'Previous question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I\'ll check.' }] },
      {
        arguments: { city: 'Cartago' },
        name: 'weather',
        role: 'toolCall',
        trackId: 'previous_call',
      },
      {
        execution: 'immediate',
        name: 'weather',
        response: [{ type: 'text', text: 'Sunny' }],
        role: 'toolResponse',
        trackId: 'previous_call',
      },
      {
        content: [{
          source: { kind: 'url', url: 'https://example.com/image.png' },
          type: 'image',
        }],
        role: 'user',
      },
    ];
    const tools: Tool[] = [{
      call: async () => [{ text: 'Sunny', type: 'text' }],
      description: 'Get the weather',
      name: 'weather',
      parameters: z.object({ city: z.string() }),
      type: 'immediate',
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
      { text: 'Hello ', type: 'textFragment' },
      { text: 'there', type: 'textFragment' },
      {
        toolCall: {
          arguments: { city: 'San José' },
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
            content: [{ text: 'Hello there', type: 'text' }],
            role: 'assistant',
          },
          {
            arguments: { city: 'San José' },
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
    expect(await stream.completed).toEqual([
      {
        content: [{ text: 'Hello there', type: 'text' }],
        role: 'assistant',
      },
      {
        arguments: { city: 'San José' },
        name: 'weather',
        role: 'toolCall',
        trackId: 'call_1',
      },
    ]);
  });

  test('surfaces API errors through the provider stream', async () => {
    globalThis.fetch = (async () => new Response(
      '{"error":{"message":"bad key"}}',
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
      expect(events[0].error.message).toContain('401');
      expect(events[0].error.message).toContain('bad key');
    }
    await expect(stream.completed).rejects.toThrow('401');
  });
});
