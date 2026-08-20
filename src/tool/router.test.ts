import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { InvalidToolParamsError, UnknownToolError } from './error';
import { ToolRouter } from './router';

import type { MessageContent } from '../agent/context/message';
import type { Tool, ToolContext } from './tool';

function text(value: string): MessageContent[] {
  return [{ text: value, type: 'text' }];
}

function immediateTool(
  name: string,
  description = `${name} capability`,
  run: (ctx: ToolContext) => Promise<MessageContent[]> = () => Promise.resolve(text(name)),
): Tool {
  return {
    description,
    name,
    parameters: z.object({}),
    prepare: () => ({ run, title: name, type: 'immediate' }),
  };
}

describe('ToolRouter', () => {
  test('exposes only its two direct routing tools in name order', () => {
    const router = new ToolRouter([immediateTool('read_file'), immediateTool('send_email')]);

    expect(Object.keys(router.tools)).toEqual(['call_tool', 'search_tool']);
    expect(Object.isFrozen(router.tools)).toBe(true);
  });

  test('searches deterministically and returns exact rendered tool definitions', async () => {
    const weather = immediateTool('weather_forecast', 'Get a weather forecast for a city.');
    const calendar = immediateTool('calendar_events', 'List appointments by date.');
    const forward = new ToolRouter([weather, calendar]);
    const reverse = new ToolRouter([calendar, weather]);

    expect(forward.search('weather city').map((tool) => tool.name)).toEqual(
      reverse.search('weather city').map((tool) => tool.name),
    );

    const execution = forward.prepare('search_tool', { query: 'weather city' });
    expect(execution.type).toBe('immediate');
    if (execution.type !== 'immediate') throw new Error('Expected immediate execution.');
    const response = await execution.run({ abortSignal: new AbortController().signal });
    const payload = JSON.parse(response[0]?.type === 'text' ? response[0].text : '') as {
      tools?: string;
    };

    expect(payload.tools).toContain('Tool: weather_forecast');
    expect(payload.tools).toContain('Description: Get a weather forecast for a city.');
    expect(payload.tools).not.toContain('Tool: calendar_events');
  });

  test('parses the JSON string and delegates immediate execution through the real schema', async () => {
    let preparedPath: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const parameters = z.object({ path: z.string().describe('File path to read.') });
    const readFile: Tool<typeof parameters> = {
      description: 'Read a file.',
      name: 'read_file',
      parameters,
      prepare: ({ path }) => {
        preparedPath = path;
        return {
          run: ({ abortSignal }) => {
            receivedSignal = abortSignal;
            return Promise.resolve(text(`read ${path}`));
          },
          title: `Read ${path}`,
          type: 'immediate',
        };
      },
    };
    const router = new ToolRouter([readFile]);

    const execution = router.prepare('call_tool', {
      name: 'read_file',
      params: '{"path":"README.md"}',
    });
    const controller = new AbortController();
    const response = await execution.run({ abortSignal: controller.signal });

    expect(execution.type).toBe('immediate');
    expect(preparedPath).toBe('README.md');
    expect(receivedSignal).toBe(controller.signal);
    expect(response).toEqual(text('read README.md'));
  });

  test('preserves deferred execution instead of running it inside call_tool', async () => {
    const result = Promise.resolve(text('finished'));
    const deferred: Tool = {
      description: 'Start background work.',
      name: 'background_job',
      parameters: z.object({}),
      prepare: () => ({
        run: () => Promise.resolve({ ack: text('started'), result }),
        title: 'Background job',
        type: 'deferred',
      }),
    };
    const router = new ToolRouter([deferred]);

    const execution = router.prepare('call_tool', { name: 'background_job', params: '{}' });
    expect(execution.type).toBe('deferred');
    if (execution.type !== 'deferred') throw new Error('Expected deferred execution.');

    const started = await execution.run({ abortSignal: new AbortController().signal });
    expect(started.ack).toEqual(text('started'));
    expect(await started.result).toEqual(text('finished'));
  });

  test('reports malformed JSON, invalid routed params, and unknown routed tools', () => {
    const parameters = z.object({ count: z.number() });
    const counted: Tool<typeof parameters> = {
      description: 'Count things.',
      name: 'count',
      parameters,
      prepare: () => ({
        run: () => Promise.resolve([]),
        title: 'Count',
        type: 'immediate',
      }),
    };
    const router = new ToolRouter([counted]);

    expect(() => router.prepare('call_tool', { name: 'count', params: '{not json}' })).toThrow(
      SyntaxError,
    );
    expect(() =>
      router.prepare('call_tool', { name: 'count', params: '{"count":"many"}' }),
    ).toThrow(InvalidToolParamsError);
    expect(() => router.prepare('call_tool', { name: 'missing', params: '{}' })).toThrow(
      UnknownToolError,
    );
  });

  test('rejects duplicate and router-reserved routed tool names', () => {
    expect(() => new ToolRouter([immediateTool('same'), immediateTool('same')])).toThrow(
      'Routed tool same is registered more than once.',
    );
    expect(() => new ToolRouter([immediateTool('call_tool')])).toThrow(
      'Routed tool call_tool conflicts with a tool router tool.',
    );
  });
});
