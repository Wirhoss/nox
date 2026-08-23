import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ChatProvider } from '../provider/provider';
import { permissiveAuthorization, TEST_AUTHORITY, testCatalog, testOrigin } from '../testFixtures';
import { EventLog } from '../utils/eventLog';
import { Context } from './context/context';
import { Runner } from './runner';

import type { ArtifactOutputHost, ArtifactOutputProvenance } from '../artifact/output';
import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool, ToolContext } from '../tool/tool';
import type { Message, MessageContent, UserMessage } from './context/message';
import type { AgentEvent } from './events';

const MODEL: ModelConfig = {
  inputModalities: ['text'],
  modelId: 'test-model',
  outputModalities: ['text'],
};

type Script = (
  signal: AbortSignal,
  options?: TextGenerateOptions,
) => AsyncIterable<ProviderSourceEvent>;

interface Gate<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let reject!: (error: Error) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** Lets queued microtasks and timers run before the assertion looks. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class ScriptedProvider extends ChatProvider {
  public readonly requests: Message[][] = [];

  readonly #scripts: Script[];

  constructor(scripts: Script[]) {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
    this.#scripts = [...scripts];
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.requests.push([...messageHistory]);
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error('Provider ran out of scripted responses.');
    yield* script(signal, _opts);
  }
}

function says(text: string): Script {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function* (): AsyncIterable<ProviderSourceEvent> {
    yield { text, type: 'textFragment' };
    yield { type: 'end' };
  };
}

function calls(name: string, trackId: string): Script {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function* (): AsyncIterable<ProviderSourceEvent> {
    yield {
      toolCall: { arguments: {}, name, role: 'toolCall', trackId },
      type: 'toolCall',
    };
    yield { type: 'end' };
  };
}

function immediateTool(name: string, run: (ctx: ToolContext) => Promise<MessageContent[]>): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: `the ${name} tool`,
    name,
    parameters: z.object({}),
    prepare: () => ({ run, title: name, type: 'immediate' }),
  };
}

function deferredTool(name: string, result: Promise<MessageContent[]>): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: `the ${name} tool`,
    name,
    parameters: z.object({}),
    prepare: () => ({
      run: () => Promise.resolve({ ack: [{ text: 'started', type: 'text' as const }], result }),
      title: name,
      type: 'deferred',
    }),
  };
}

function user(text: string, subject = 'alice'): UserMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    messageId: `user-${text}`,
    origin: testOrigin(subject),
    role: 'user',
  };
}

function setup(
  scripts: Script[],
  tools: Tool[] = [],
  maxIterations?: 'unlimited' | number,
  contextWindow?: number,
  artifactOutputs?: ArtifactOutputHost,
): {
  context: Context;
  events: EventLog<AgentEvent>;
  provider: ScriptedProvider;
  runner: Runner;
} {
  const provider = new ScriptedProvider(scripts);
  const context = new Context('system', provider, {
    contextWindow,
    tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
  });
  const events = new EventLog<AgentEvent>();
  const runner = new Runner(context, events, provider, MODEL, {
    ...(artifactOutputs === undefined ? {} : { artifactOutputs }),
    authorities: testCatalog(),
    authorization: permissiveAuthorization,
    maxIterations,
    sessionId: 'session-1',
  });
  return { context, events, provider, runner };
}

function roles(context: Context): string[] {
  return context.getHistory().map((message) => message.role);
}

function eventTypes(events: EventLog<AgentEvent>): string[] {
  return events.snapshot().map((event) => event.type);
}

describe('Runner', () => {
  test('a user message runs one request and completes', async () => {
    const { context, events, provider, runner } = setup([says('hello')]);

    runner.send(user('hi'));
    await runner.idle;

    expect(provider.requests).toHaveLength(1);
    expect(roles(context)).toEqual(['user', 'assistant']);
    expect(eventTypes(events)).toEqual(['runStarted', 'assistantTextFragment', 'runCompleted']);
    expect(events.snapshot()[0]).toMatchObject({ modelId: 'test-model', trigger: 'user' });
    expect(events.snapshot().at(-1)).toMatchObject({ status: 'completed' });
    expect(runner.state).toBe('idle');
  });

  test('a tool call feeds the next request and the run ends when nothing is left', async () => {
    const { context, provider, runner } = setup(
      [calls('echo', 'track-1'), says('done')],
      [immediateTool('echo', () => Promise.resolve([{ text: 'echoed', type: 'text' }]))],
    );

    runner.send(user('hi'));
    await runner.idle;

    expect(provider.requests).toHaveLength(2);
    expect(roles(context)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse',
      'assistant',
    ]);
  });

  test('gives a provider a scoped sink for native artifact output', async () => {
    const artifactOutputs: ArtifactOutputHost = {
      publisher: () => ({
        publish: () =>
          Promise.resolve({
            artifact: {
              artifactId: 'art_native001',
              filename: 'generated.png',
              mediaType: 'image/png',
              size: 8,
            },
            type: 'artifact',
          }),
      }),
    };
    const nativeOutput: Script = async function* (_signal, options) {
      if (options?.artifactOutput === undefined) throw new Error('missing artifact output');
      const part = await options.artifactOutput.publish({
        data: new Blob(['native']),
        declaredMediaType: 'image/png',
        filename: 'generated.png',
      });
      yield { artifact: part.artifact, type: 'artifact' };
      yield { type: 'end' };
    };
    const { context, runner } = setup([nativeOutput], [], undefined, undefined, artifactOutputs);

    runner.send(user('generate an image'));
    await runner.idle;

    const assistant = context.getFullHistory().find((message) => message.role === 'assistant');
    expect(assistant?.role === 'assistant' ? assistant.content : []).toEqual([
      {
        artifact: {
          artifactId: 'art_native001',
          filename: 'generated.png',
          mediaType: 'image/png',
          size: 8,
        },
        type: 'artifact',
      },
    ]);
  });

  test('promotes a tool-published artifact into the final assistant reply', async () => {
    const provenance: ArtifactOutputProvenance[] = [];
    const artifactOutputs: ArtifactOutputHost = {
      publisher: (entry) => {
        provenance.push(entry);
        return {
          publish: () =>
            Promise.resolve({
              artifact: {
                artifactId: 'art_generated1',
                filename: 'report.txt',
                mediaType: 'text/plain',
                size: 6,
              },
              type: 'artifact',
            }),
        };
      },
    };
    const publish = immediateTool('publish', async (ctx) => {
      if (ctx.artifacts === undefined) throw new Error('missing artifact output');
      return [
        { text: 'created', type: 'text' },
        await ctx.artifacts.publish({
          data: new Blob(['report']),
          declaredMediaType: 'text/plain',
          filename: 'report.txt',
        }),
      ];
    });
    const { context, runner } = setup(
      [calls('publish', 'track-output'), says('ready')],
      [publish],
      undefined,
      undefined,
      artifactOutputs,
    );

    runner.send(user('make a report'));
    await runner.idle;

    const toolResponse = context
      .getFullHistory()
      .find((message) => message.role === 'toolResponse');
    const final = context.getFullHistory().findLast((message) => message.role === 'assistant');
    const toolArtifact =
      toolResponse?.role === 'toolResponse'
        ? toolResponse.response.find((part) => part.type === 'artifact')
        : undefined;
    expect(toolArtifact?.type === 'artifact' ? toolArtifact.artifact.artifactId : undefined).toBe(
      'art_generated1',
    );
    expect(final?.role).toBe('assistant');
    expect(final?.role === 'assistant' ? final.content : []).toEqual([
      { text: 'ready', type: 'text' },
      {
        artifact: {
          artifactId: 'art_generated1',
          filename: 'report.txt',
          mediaType: 'text/plain',
          size: 6,
        },
        type: 'artifact',
      },
    ]);
    const toolProvenance = provenance.find((entry) => entry.type === 'tool');
    expect(toolProvenance).toMatchObject({
      details: {
        sessionId: 'session-1',
        toolName: 'publish',
        trackId: 'track-output',
      },
      type: 'tool',
    });
    expect(typeof toolProvenance?.details?.runId).toBe('string');
  });

  test('tool calls in one reply run concurrently', async () => {
    let active = 0;
    let peak = 0;
    const hold = gate<MessageContent[]>();
    const slow = immediateTool('slow', async () => {
      active += 1;
      peak = Math.max(peak, active);
      const response = await hold.promise;
      active -= 1;
      return response;
    });
    const { runner } = setup(
      [
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* (): AsyncIterable<ProviderSourceEvent> {
          yield {
            toolCall: { arguments: {}, name: 'slow', role: 'toolCall', trackId: 'a' },
            type: 'toolCall',
          };
          yield {
            toolCall: { arguments: {}, name: 'slow', role: 'toolCall', trackId: 'b' },
            type: 'toolCall',
          };
          yield { type: 'end' };
        },
        says('done'),
      ],
      [slow],
    );

    runner.send(user('hi'));
    await settle();
    hold.resolve([{ text: 'ok', type: 'text' }]);
    await runner.idle;

    expect(peak).toBe(2);
  });

  test('a deferred result landing after the last request keeps the run going', async () => {
    const work = gate<MessageContent[]>();
    const { context, events, provider, runner } = setup(
      [
        calls('background', 'track-1'),
        // The reply that would have ended the run: the result lands while it
        // streams, which is exactly the window where a run could close on an
        // unseen message.
        async function* (): AsyncIterable<ProviderSourceEvent> {
          work.resolve([{ text: 'the answer', type: 'text' }]);
          await settle();
          yield { text: 'working on it', type: 'textFragment' };
          yield { type: 'end' };
        },
        says('here it is'),
      ],
      [deferredTool('background', work.promise)],
    );

    runner.send(user('go'));
    await runner.idle;

    expect(provider.requests).toHaveLength(3);
    expect(roles(context)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse', // deferredAck
      'assistant',
      'toolResponse', // deferredResult
      'assistant',
    ]);
    // The model actually saw it: it is in the history of the last request.
    expect(provider.requests[2]?.some((message) => message.role === 'toolResponse')).toBeTrue();
    expect(eventTypes(events).filter((type) => type === 'runStarted')).toHaveLength(1);
  });

  test('a deferred result landing while idle wakes a run of its own', async () => {
    const work = gate<MessageContent[]>();
    const { context, events, provider, runner } = setup(
      [calls('background', 'track-1'), says('acknowledged'), says('and now the result')],
      [deferredTool('background', work.promise)],
    );

    runner.send(user('go'));
    await runner.idle;
    expect(provider.requests).toHaveLength(2);
    expect(runner.state).toBe('idle');

    work.resolve([{ text: 'the answer', type: 'text' }]);
    await settle();
    await runner.idle;

    expect(provider.requests).toHaveLength(3);
    expect(roles(context).at(-2)).toBe('toolResponse');
    expect(events.snapshot().filter((event) => event.type === 'runStarted')).toMatchObject([
      { trigger: 'user' },
      { trigger: 'deferredResult' },
    ]);
  });

  test('a message sent mid-run joins the run instead of starting another', async () => {
    const hold = gate<MessageContent[]>();
    const { context, events, provider, runner } = setup(
      [calls('slow', 'track-1'), says('answering both')],
      [immediateTool('slow', () => hold.promise)],
    );

    runner.send(user('first'));
    await settle();
    runner.send(user('second'));
    hold.resolve([{ text: 'tool done', type: 'text' }]);
    await runner.idle;

    expect(eventTypes(events).filter((type) => type === 'runStarted')).toHaveLength(1);
    expect(roles(context)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse',
      'user',
      'assistant',
    ]);
    // The second message was drained before the request that followed it.
    expect(provider.requests[1]?.at(-1)).toMatchObject({ role: 'user' });
  });

  test('the iteration ceiling ends the run without inventing a message', async () => {
    const { context, events, provider, runner } = setup(
      [calls('echo', 'a'), calls('echo', 'b'), calls('echo', 'c')],
      [immediateTool('echo', () => Promise.resolve([{ text: 'echoed', type: 'text' }]))],
      2,
    );

    runner.send(user('hi'));
    await runner.idle;

    expect(provider.requests).toHaveLength(2);
    expect(events.snapshot().at(-1)).toMatchObject({ status: 'maxIterations' });
    expect(roles(context).at(-1)).toBe('toolResponse');
    expect(roles(context).filter((role) => role === 'user')).toHaveLength(1);
  });

  test('a provider failure closes the run and leaves the runner usable', async () => {
    const { events, runner } = setup([
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      async function* (): AsyncIterable<ProviderSourceEvent> {
        throw new Error('boom');
      },
    ]);

    runner.send(user('hi'));
    await runner.idle;

    const failure = events.snapshot().find((event) => event.type === 'error');
    expect(failure?.type === 'error' && failure.error.message).toContain('boom');
    expect(events.snapshot().at(-1)).toMatchObject({ status: 'failed' });
    expect(runner.state).toBe('idle');
  });

  test("a failed principal's run does not consume another principal's queued turn", async () => {
    const entered = gate<undefined>();
    const release = gate<undefined>();
    const { events, provider, runner } = setup([
      // eslint-disable-next-line require-yield
      async function* (): AsyncIterable<ProviderSourceEvent> {
        entered.resolve(undefined);
        await release.promise;
        throw new Error('alice failed');
      },
      says('bob answered'),
    ]);

    runner.send(user('first', 'alice'));
    await entered.promise;
    runner.send(user('second', 'bob'));
    release.resolve(undefined);
    await runner.idle;

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.at(-1)).toMatchObject({ role: 'user' });
    expect(
      events
        .snapshot()
        .filter((event) => event.type === 'runStarted')
        .map((event) => event.authority.principal.subject),
    ).toEqual(['alice', 'bob']);
  });

  test('an unknown tool answers the call instead of breaking the pairing', async () => {
    const { context, runner } = setup([calls('missing', 'track-1'), says('sorry')]);

    runner.send(user('hi'));
    await runner.idle;

    expect(roles(context)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse',
      'assistant',
    ]);
    expect(context.getHistory()[3]).toMatchObject({ isError: true });
  });

  test('abort leaves every tool call paired with a response', async () => {
    const abortable = immediateTool(
      'wait',
      (ctx) =>
        new Promise<MessageContent[]>((resolve) => {
          const finish = (): void => {
            resolve([{ text: 'aborted', type: 'text' }]);
          };
          if (ctx.abortSignal.aborted) finish();
          else ctx.abortSignal.addEventListener('abort', finish, { once: true });
        }),
    );
    const { context, events, runner } = setup([calls('wait', 'track-1')], [abortable]);

    runner.send(user('hi'));
    await settle();

    expect(await runner.abort()).toBeTrue();
    expect(roles(context)).toEqual(['user', 'assistant', 'toolCall', 'toolResponse']);
    expect(events.snapshot().at(-1)).toMatchObject({ status: 'aborted' });
    expect(await runner.abort()).toBeFalse();
  });

  test('steer cuts the run short and speaks over it', async () => {
    const abortable = immediateTool(
      'wait',
      (ctx) =>
        new Promise<MessageContent[]>((resolve) => {
          const finish = (): void => {
            resolve([{ text: 'aborted', type: 'text' }]);
          };
          if (ctx.abortSignal.aborted) finish();
          else ctx.abortSignal.addEventListener('abort', finish, { once: true });
        }),
    );
    const { context, events, runner } = setup(
      [calls('wait', 'track-1'), says('new plan it is')],
      [abortable],
    );

    runner.send(user('first'));
    await settle();
    await runner.steer(user('change of plans'));
    await runner.idle;

    expect(roles(context)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse',
      'user',
      'assistant',
    ]);
    expect(events.snapshot().filter((event) => event.type === 'runStarted')).toMatchObject([
      { trigger: 'user' },
      { trigger: 'steer' },
    ]);
  });

  test('usage is reported, totalled and used to calibrate context pressure', async () => {
    const { context, events, runner } = setup(
      [
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* (): AsyncIterable<ProviderSourceEvent> {
          yield { text: 'hi', type: 'textFragment' };
          yield {
            type: 'end',
            usage: { cacheReadTokens: 2, inputTokens: 700, outputTokens: 5 },
          };
        },
      ],
      [],
      undefined,
      1_000,
    );

    expect(context.isUnderPressure()).toBeFalse();
    runner.send(user('hi'));
    await runner.idle;

    expect(context.isUnderPressure()).toBeTrue();
    expect(events.snapshot().find((event) => event.type === 'usage')).toMatchObject({
      usage: { inputTokens: 700, outputTokens: 5 },
    });
    expect(events.snapshot().at(-1)).toMatchObject({
      usage: { cacheReadTokens: 2, inputTokens: 700, outputTokens: 5 },
    });
  });

  test('a deferred result landing after stop is recorded but wakes nothing', async () => {
    const work = gate<MessageContent[]>();
    const { context, events, provider, runner } = setup(
      [calls('background', 'track-1'), says('acknowledged')],
      [deferredTool('background', work.promise)],
    );

    runner.send(user('go'));
    await runner.idle;
    await runner.stop();

    work.resolve([{ text: 'too late', type: 'text' }]);
    await settle();

    expect(runner.state).toBe('stopped');
    expect(provider.requests).toHaveLength(2);
    expect(events.isClosed).toBeTrue();
    expect(context.getFullHistory().at(-1)).toMatchObject({
      execution: 'deferredResult',
      trackId: 'track-1',
    });
  });
});
