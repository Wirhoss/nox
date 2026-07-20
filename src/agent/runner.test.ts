import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ProviderStream } from '../provider';
import { EventLog } from '../utils';

import { Context } from './context';
import { Runner, StopReason } from './runner';

import type {
  Message,
  ModelConfig,
  Provider,
  ProviderStreamEvent,
  ToolCallMessage,
  UserMessage,
} from '../provider';
import type { ImmediateTool } from '../tool';
import type { AgentStreamEvent } from './runner';

const model = { type: 'text', modelId: 'test-model' } as ModelConfig;

function userMessage(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function toolCallMessage(name: string, trackId: string): ToolCallMessage {
  return { role: 'toolCall', name, trackId, arguments: {} };
}

type StreamScript = (signal: AbortSignal) => AsyncGenerator<ProviderStreamEvent>;

function fakeProvider(scripts: StreamScript[]): Provider {
  let call = 0;
  return {
    getMessageStream(_system: string, _history: Message[], _tools: unknown, opts?: { signal?: AbortSignal }) {
      const script = scripts[call++];
      if (!script) throw new Error('Fake provider ran out of scripted streams');
      const signal = opts?.signal ?? new AbortController().signal;
      return new ProviderStream(script(signal), signal);
    },
  } as unknown as Provider;
}

function setup(scripts: StreamScript[], tools: ImmediateTool[] = []) {
  const context = new Context('system prompt');
  for (const tool of tools) context.tools[tool.name] = tool;
  const eventLog = new EventLog<AgentStreamEvent>();
  const runner = new Runner(context, eventLog, fakeProvider(scripts), model, 5);
  return { context, eventLog, runner };
}

describe('Runner', () => {
  test('provider stream errors reject run() and land in the event log', async () => {
    const { eventLog, runner } = setup([
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error('boom');
      },
    ]);

    await expect(runner.run(userMessage('hi'))).rejects.toThrow('Error in agent run loop: boom');
    expect(eventLog.snapshot().some((event) => event.type === 'error')).toBe(true);
  });

  test('steer keeps tool calls paired with responses in the history', async () => {
    const abortableTool: ImmediateTool = {
      type: 'immediate',
      name: 'wait',
      description: 'waits until aborted',
      parameters: z.object({}),
      call: (_params, ctx) => new Promise((resolve) => {
        const finish = () => resolve([{ type: 'text', text: 'aborted' }]);
        if (ctx.abortSignal.aborted) finish();
        else ctx.abortSignal.addEventListener('abort', finish, { once: true });
      }),
    };
    const toolCall = toolCallMessage('wait', 'call-1');
    const { context, runner } = setup([
      async function* () {
        yield { type: 'toolCall', toolCall };
        yield { type: 'end', messages: [toolCall] };
      },
      async function* () {
        yield { type: 'textFragment', text: 'ok' };
        yield { type: 'end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] };
      },
    ], [abortableTool]);

    const firstRun = runner.run(userMessage('start'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await runner.steer(userMessage('change of plans'))).toBe(StopReason.Completed);
    expect(await firstRun).toBe(StopReason.Aborted);

    const roles = context.messageHistory.map((message) => message.role);
    expect(roles).toEqual(['user', 'toolCall', 'toolResponse', 'user', 'assistant']);
  });

  test('tool calls appear exactly once in the event log', async () => {
    const echoTool: ImmediateTool = {
      type: 'immediate',
      name: 'echo',
      description: 'echoes',
      parameters: z.object({}),
      call: async () => [{ type: 'text', text: 'done' }],
    };
    const toolCall = toolCallMessage('echo', 'call-1');
    const { context, eventLog, runner } = setup([
      async function* () {
        yield { type: 'toolCall', toolCall };
        yield { type: 'end', messages: [toolCall] };
      },
      async function* () {
        yield { type: 'end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'bye' }] }] };
      },
    ], [echoTool]);

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);

    const toolCallEvents = eventLog.snapshot().filter(
      (event) => event.type === 'message' && event.message.role === 'toolCall',
    );
    expect(toolCallEvents).toHaveLength(1);
    expect(context.messageHistory.map((message) => message.role))
      .toEqual(['user', 'toolCall', 'toolResponse', 'assistant']);
  });

  test('deferred tools report an error response instead of empty success', async () => {
    const deferredCall = toolCallMessage('later', 'call-1');
    const { context, runner } = setup([
      async function* () {
        yield { type: 'toolCall', toolCall: deferredCall };
        yield { type: 'end', messages: [deferredCall] };
      },
      async function* () {
        yield { type: 'end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'bye' }] }] };
      },
    ]);
    context.tools['later'] = {
      type: 'deferred',
      name: 'later',
      description: 'deferred',
      parameters: z.object({}),
      start: async () => ({ ack: 'ack', result: Promise.resolve([]) }),
    };

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);

    const response = context.messageHistory.find((message) => message.role === 'toolResponse');
    expect(response?.isError).toBe(true);
  });
});
