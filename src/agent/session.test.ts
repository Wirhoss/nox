import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Database } from '../database/database';
import { SessionStore } from '../database/sessionStore';
import { ChatProvider } from '../provider/provider';
import { Session } from './session';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool } from '../tool/tool';
import type { Message, MessageContent } from './context/message';
import type { AgentEvent } from './events';

const MODEL: ModelConfig = { modelId: 'test-model', type: 'text' };

type Script = () => AsyncIterable<ProviderSourceEvent>;

const directories: string[] = [];
const opened: Database[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    // Windows keeps the SQLite file handle briefly after close(); the temp
    // directory is disposable either way, so a failed unlink is not a failure.
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-session-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
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
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.requests.push([...messageHistory]);
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error('Provider ran out of scripted responses.');
    yield* script();
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
    yield { toolCall: { arguments: {}, name, role: 'toolCall', trackId }, type: 'toolCall' };
    yield { type: 'end' };
  };
}

function echoTool(): Tool {
  return {
    description: 'echoes',
    name: 'echo',
    parameters: z.object({}),
    prepare: () => ({
      run: (): Promise<MessageContent[]> => Promise.resolve([{ text: 'echoed', type: 'text' }]),
      title: 'echo',
      type: 'immediate',
    }),
  };
}

async function collectUntil(
  events: AsyncGenerator<AgentEvent>,
  type: AgentEvent['type'],
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.type === type) break;
  }
  return collected;
}

describe('Session', () => {
  test('a turn is persisted and replays on reopen', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new ScriptedProvider([says('hello')]), MODEL, {
      systemPrompt: 'system',
    });

    session.send('hi');
    await session.idle;
    await session.stop();

    const resumedProvider = new ScriptedProvider([says('again')]);
    const resumed = await Session.open(database, resumedProvider, MODEL, {
      sessionId: session.sessionId,
      systemPrompt: 'system',
    });

    expect(resumed.getTranscript().map((message) => message.role)).toEqual(['user', 'assistant']);

    resumed.send('and again');
    await resumed.idle;

    // The model was handed the history it had before the process restarted.
    expect(resumedProvider.requests[0]?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    await resumed.stop();
  });

  test('a resumed session persists where the stored transcript left off', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new ScriptedProvider([says('hello')]), MODEL, {
      systemPrompt: 'system',
    });

    session.send('hi');
    await session.idle;
    await session.stop();

    const resumed = await Session.open(database, new ScriptedProvider([says('again')]), MODEL, {
      sessionId: session.sessionId,
      systemPrompt: 'system',
    });
    resumed.send('and again');
    await resumed.idle;
    await resumed.stop();

    // Read back from storage, not from the live session: a resumed session that
    // restarts its sequence at zero collides with every stored row, reports the
    // failure, and carries on with a transcript that only exists in memory.
    const stored = await new SessionStore(database).load(session.sessionId);

    expect(stored?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  test('tool traffic reaches storage as well as the event log', async () => {
    const database = await openDatabase();
    const session = await Session.open(
      database,
      new ScriptedProvider([calls('echo', 'track-1'), says('done')]),
      MODEL,
      { context: { tools: { echo: echoTool() } }, systemPrompt: 'system' },
    );

    session.send('use the tool');
    await session.idle;
    await session.stop();

    const stored = await new SessionStore(database).load(session.sessionId);
    expect(stored?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant', // textless tool-call turn
      'toolCall',
      'toolResponse',
      'assistant',
    ]);
  });

  test('every appended message is announced exactly once', async () => {
    const database = await openDatabase();
    const session = await Session.open(
      database,
      new ScriptedProvider([calls('echo', 'track-1'), says('done')]),
      MODEL,
      { context: { tools: { echo: echoTool() } }, systemPrompt: 'system' },
    );
    const collected = collectUntil(session.events, 'runCompleted');

    session.send('use the tool');
    await session.idle;

    const announced = (await collected).filter((event) => event.type === 'message');
    expect(announced.map((event) => event.message.messageId)).toEqual(
      session.getTranscript().map((message) => message.messageId),
    );
    await session.stop();
  });

  test('a session started without an id gets one and can be resumed by it', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new ScriptedProvider([]), MODEL, {
      systemPrompt: 'system',
      title: 'First run',
    });

    expect(session.sessionId).not.toBe('');
    await session.stop();

    const stored = await new SessionStore(database).load(session.sessionId);
    expect(stored?.session.title).toBe('First run');
  });

  test('a storage failure is announced and the conversation carries on', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new ScriptedProvider([says('hello')]), MODEL, {
      systemPrompt: 'system',
    });
    const collected = collectUntil(session.events, 'runCompleted');

    await database.close();
    session.send('hi');
    await session.idle;
    await session.flushed;

    // The reply happened and is in the transcript; only durability was lost.
    expect(session.getTranscript().map((message) => message.role)).toEqual(['user', 'assistant']);
    expect((await collected).some((event) => event.type === 'error')).toBeTrue();
  });

  test('stop closes the event stream for its subscribers', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new ScriptedProvider([says('hello')]), MODEL, {
      systemPrompt: 'system',
    });
    const drained = (async (): Promise<number> => {
      let count = 0;
      for await (const _event of session.events) count += 1;
      return count;
    })();

    session.send('hi');
    await session.idle;
    await session.stop();

    expect(await drained).toBeGreaterThan(0);
    expect(session.state).toBe('stopped');
  });
});
