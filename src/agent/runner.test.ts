import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { EscalationHub, ToolGate } from '../gate';
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
import type { DeferredTool, ImmediateTool } from '../tool';
import type { AgentStreamEvent, RunnerOptions } from './runner';

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

function setup(scripts: StreamScript[], tools: ImmediateTool[] = [], options: Partial<RunnerOptions> = {}) {
  const context = new Context('system prompt');
  for (const tool of tools) context.tools[tool.name] = tool;
  const eventLog = new EventLog<AgentStreamEvent>();
  const runner = new Runner(context, eventLog, fakeProvider(scripts), model, { maxIterations: 5, ...options });
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
    expect(eventLog.snapshot().find((event) => event.type === 'runCompleted')).toMatchObject({
      status: 'failed',
      usage: { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 },
    });
  });

  test('emits measured run lifecycle metadata', async () => {
    const { eventLog, runner } = setup([
      async function* () {
        yield { type: 'textFragment', text: 'hello' };
        yield {
          type: 'end',
          messages: [assistant('hello')],
          usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5 },
        };
      },
    ]);

    expect(await runner.run(userMessage('hi'))).toBe(StopReason.Completed);
    const events = eventLog.snapshot();
    const started = events.find((event) => event.type === 'runStarted');
    const completed = events.find((event) => event.type === 'runCompleted');

    expect(started).toMatchObject({ modelId: 'test-model', type: 'runStarted' });
    expect(completed).toMatchObject({
      runId: started?.type === 'runStarted' ? started.runId : undefined,
      status: 'completed',
      type: 'runCompleted',
      usage: { cacheReadTokens: 5, inputTokens: 12, outputTokens: 3 },
    });
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

});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

async function waitForPermissionRequest(eventLog: EventLog<AgentStreamEvent>): Promise<string> {
  for await (const event of eventLog.subscribe()) {
    if (event.type === 'permissionRequest') return event.requestId;
  }
  throw new Error('Event log closed without a permission request');
}

function trackingTool(onCall: () => void): ImmediateTool {
  return {
    type: 'immediate',
    name: 'echo',
    description: 'echoes',
    parameters: z.object({}),
    call: async () => {
      onCall();
      return [{ type: 'text', text: 'done' }];
    },
  };
}

describe('Runner gate', () => {
  const gatedScripts = (): StreamScript[] => {
    const toolCall = toolCallMessage('echo', 'call-1');
    return [
      async function* () {
        yield { type: 'toolCall', toolCall };
        yield { type: 'end', messages: [toolCall] };
      },
      async function* () {
        yield { type: 'end', messages: [assistant('bye')] };
      },
    ];
  };

  test('deny blocks execution with a terminal error response', async () => {
    let executed = false;
    const { context, runner } = setup(gatedScripts(), [trackingTool(() => { executed = true; })], {
      gate: new ToolGate([{ tools: ['echo'], verdict: 'deny', reason: 'Not allowed.' }]),
    });

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);

    expect(executed).toBe(false);
    const response = context.messageHistory.find((message) => message.role === 'toolResponse');
    expect(response?.isError).toBe(true);
    expect(response?.response[0]?.type === 'text' && response.response[0].text).toContain('denied by policy');
  });

  test('approved escalation lets the tool run', async () => {
    let executed = false;
    const escalation = new EscalationHub();
    const { eventLog, runner } = setup(gatedScripts(), [trackingTool(() => { executed = true; })], {
      gate: new ToolGate([{ tools: ['echo'], verdict: 'escalate', reason: 'Needs approval.' }]),
      escalation,
    });

    const running = runner.run(userMessage('go'));
    const requestId = await waitForPermissionRequest(eventLog);
    expect(escalation.resolve(requestId, true)).toBe(true);
    expect(await running).toBe(StopReason.Completed);

    expect(executed).toBe(true);
    expect(eventLog.snapshot().some(
      (event) => event.type === 'permissionResolved' && event.resolution === 'approved',
    )).toBe(true);
  });

  test('denied escalation blocks execution', async () => {
    let executed = false;
    const escalation = new EscalationHub();
    const { context, eventLog, runner } = setup(gatedScripts(), [trackingTool(() => { executed = true; })], {
      gate: new ToolGate([{ tools: ['echo'], verdict: 'escalate', reason: 'Needs approval.' }]),
      escalation,
    });

    const running = runner.run(userMessage('go'));
    const requestId = await waitForPermissionRequest(eventLog);
    escalation.resolve(requestId, false);
    expect(await running).toBe(StopReason.Completed);

    expect(executed).toBe(false);
    const response = context.messageHistory.find((message) => message.role === 'toolResponse');
    expect(response?.isError).toBe(true);
  });

  test('an unanswered escalation times out into a denial', async () => {
    let executed = false;
    const { context, eventLog, runner } = setup(gatedScripts(), [trackingTool(() => { executed = true; })], {
      gate: new ToolGate([{ tools: ['echo'], verdict: 'escalate', reason: 'Needs approval.' }]),
      escalation: new EscalationHub(),
      escalationTimeoutMs: 15,
    });

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);

    expect(executed).toBe(false);
    const response = context.messageHistory.find((message) => message.role === 'toolResponse');
    expect(response?.isError).toBe(true);
    expect(eventLog.snapshot().some(
      (event) => event.type === 'permissionResolved' && event.resolution === 'timeout',
    )).toBe(true);
  });
});

describe('Runner deferred tools', () => {
  function deferredTool(resultDelayMs: number): DeferredTool {
    return {
      type: 'deferred',
      name: 'job',
      description: 'long job',
      parameters: z.object({}),
      start: async () => ({
        ack: 'job started',
        result: sleep(resultDelayMs).then(() => [{ type: 'text' as const, text: 'job finished' }]),
      }),
    };
  }

  test('acks immediately and injects the result into the ongoing loop', async () => {
    const toolCall = toolCallMessage('job', 'call-1');
    const { context, runner } = setup([
      async function* () {
        yield { type: 'toolCall', toolCall };
        yield { type: 'end', messages: [toolCall] };
      },
      async function* () {
        await sleep(60);
        yield { type: 'end', messages: [assistant('working')] };
      },
      async function* () {
        yield { type: 'end', messages: [assistant('done')] };
      },
    ]);
    context.tools['job'] = deferredTool(20);

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);

    expect(context.messageHistory.map((message) => message.role))
      .toEqual(['user', 'toolCall', 'toolResponse', 'assistant', 'toolResponse', 'assistant']);
    const responses = context.messageHistory.filter((message) => message.role === 'toolResponse');
    expect(responses.map((response) => response.execution)).toEqual(['deferredAck', 'deferredResult']);
  });

  test('a result landing while idle wakes the runner without a user message', async () => {
    const toolCall = toolCallMessage('job', 'call-1');
    const { context, runner } = setup([
      async function* () {
        yield { type: 'toolCall', toolCall };
        yield { type: 'end', messages: [toolCall] };
      },
      async function* () {
        yield { type: 'end', messages: [assistant('ok, running in background')] };
      },
      async function* () {
        yield { type: 'end', messages: [assistant('job is done')] };
      },
    ]);
    context.tools['job'] = deferredTool(40);

    expect(await runner.run(userMessage('go'))).toBe(StopReason.Completed);
    expect(context.messageHistory).toHaveLength(4);

    await sleep(100);

    expect(context.messageHistory.map((message) => message.role))
      .toEqual(['user', 'toolCall', 'toolResponse', 'assistant', 'toolResponse', 'assistant']);
    const result = context.messageHistory.filter((message) => message.role === 'toolResponse').at(-1);
    expect(result?.execution).toBe('deferredResult');
    expect(context.messageHistory.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
