import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Database } from '../database/database';
import { ChatProvider } from '../provider/provider';
import { Agent } from './agent';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool } from '../tool/tool';
import type { Message, MessageContent } from './context/message';

const MODEL: ModelConfig = { modelId: 'test-model', type: 'text' };

interface Request {
  history: Message[];
  systemPrompt: string;
  toolNames: string[];
}

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
  const directory = mkdtempSync(join(tmpdir(), 'nox-agent-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

class RecordingProvider extends ChatProvider {
  public readonly requests: Request[] = [];

  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.requests.push({
      history: [...messageHistory],
      systemPrompt,
      toolNames: tools.map((tool) => tool.name),
    });
    yield { text: 'ok', type: 'textFragment' };
    yield { type: 'end' };
  }
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

describe('Agent', () => {
  test('every session it opens sends the same prefix', async () => {
    const provider = new RecordingProvider();
    const agent = new Agent(await openDatabase(), provider, MODEL, {
      systemPrompt: 'you are nox',
      tools: { echo: echoTool() },
    });

    const first = await agent.openSession();
    const second = await agent.openSession();
    first.send('hi');
    await first.idle;
    second.send('hi');
    await second.idle;

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.systemPrompt).toBe('you are nox');
    expect(provider.requests[1]?.systemPrompt).toBe('you are nox');
    expect(provider.requests[0]?.toolNames).toEqual(provider.requests[1]?.toolNames ?? []);
    expect(provider.requests[0]?.toolNames).toContain('echo');

    await first.stop();
    await second.stop();
  });

  test('sessions from one agent keep separate transcripts', async () => {
    const provider = new RecordingProvider();
    const agent = new Agent(await openDatabase(), provider, MODEL, { systemPrompt: 'system' });

    const first = await agent.openSession();
    const second = await agent.openSession();
    first.send('only in the first');
    await first.idle;

    expect(first.getTranscript()).toHaveLength(2);
    expect(second.getTranscript()).toHaveLength(0);
    expect(first.sessionId).not.toBe(second.sessionId);

    await first.stop();
    await second.stop();
  });

  test('a session resumes by id with its history intact', async () => {
    const database = await openDatabase();
    const provider = new RecordingProvider();
    const agent = new Agent(database, provider, MODEL, { systemPrompt: 'system' });

    const session = await agent.openSession({ title: 'first run' });
    session.send('remember this');
    await session.idle;
    await session.stop();

    const resumed = await agent.openSession({ sessionId: session.sessionId });
    expect(resumed.getTranscript().map((message) => message.role)).toEqual(['user', 'assistant']);

    resumed.send('and this');
    await resumed.idle;
    expect(provider.requests.at(-1)?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);

    await resumed.stop();
  });

  test('an unknown session id starts a session under that name', async () => {
    const agent = new Agent(await openDatabase(), new RecordingProvider(), MODEL, {
      systemPrompt: 'system',
    });

    const session = await agent.openSession({ sessionId: 'discord-channel-42' });

    expect(session.sessionId).toBe('discord-channel-42');
    expect(session.getTranscript()).toHaveLength(0);
    await session.stop();
  });
});
