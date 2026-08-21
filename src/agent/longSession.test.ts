import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Database } from '../database/database';
import { SessionStore } from '../database/sessionStore';
import { ChatProvider } from '../provider/provider';
import { COMPACT_PROMPT } from './context/prompt';
import { Session } from './session';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool } from '../tool/tool';
import type { Message } from './context/message';

const MODEL: ModelConfig = { modelId: 'test-model', type: 'text' };

/** Small enough that a few turns of tool traffic force both reductions. */
const CONTEXT_WINDOW = 2400;
const TURNS = 120;

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
  const directory = mkdtempSync(join(tmpdir(), 'nox-long-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

/**
 * Answers by rule rather than by script, because a run long enough to compact
 * cannot have its requests counted in advance. Every reply cites the turn it
 * belongs to, so anything the transcript drops is identifiable afterwards.
 */
class RuleProvider extends ChatProvider {
  public compactions = 0;

  public readonly requests: Message[][] = [];

  #turn = 0;

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
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    if (systemPrompt === COMPACT_PROMPT) {
      this.compactions += 1;
      // Deliberately short: a summary that does not reduce tokens is rejected,
      // and this test needs compaction to actually apply.
      yield { text: `handoff after ${String(this.#turn)} turns`, type: 'textFragment' };
      yield { type: 'end' };
      return;
    }

    this.requests.push([...messageHistory]);
    const last = messageHistory.at(-1);

    // Answer a tool response; otherwise call the tool. Every turn therefore
    // produces the call/response pair that folding exists to collapse.
    if (last?.role === 'toolResponse') {
      yield { text: `answer ${String(this.#turn)}`, type: 'textFragment' };
      yield { type: 'end' };
      return;
    }

    this.#turn += 1;
    yield {
      toolCall: {
        arguments: { turn: this.#turn },
        name: 'work',
        role: 'toolCall',
        trackId: `track-${String(this.#turn)}`,
      },
      type: 'toolCall',
    };
    yield { type: 'end' };
  }
}

function workTool(): Tool {
  return {
    description: 'does mechanical work',
    name: 'work',
    parameters: z.object({ turn: z.number() }),
    prepare: (params) => ({
      run: () =>
        // Bulky and low-value: exactly the traffic folding is meant to reclaim.
        Promise.resolve([
          {
            text: `result for turn ${String(params.turn)}: ${'detail '.repeat(40)}`,
            type: 'text' as const,
          },
        ]),
      title: 'work',
      type: 'immediate' as const,
    }),
  };
}

async function drive(session: Session, turns: number): Promise<void> {
  for (let turn = 1; turn <= turns; turn += 1) {
    session.send(`request ${String(turn)}`);
    await session.idle;
  }
}

describe('a session that runs long enough to fold and compact', () => {
  test('stays bounded, loses nothing, and replays to an identical active history', async () => {
    const database = await openDatabase();
    const provider = new RuleProvider();
    const session = await Session.open(database, provider, MODEL, {
      context: { contextWindow: CONTEXT_WINDOW, tools: { work: workTool() } },
      sessionId: 'long-run',
      systemPrompt: 'system',
    });

    await drive(session, TURNS);
    await session.stop();

    const transcript = session.getTranscript();
    const active = session.getHistory();

    // The test proves nothing unless both reductions actually fired.
    expect(transcript.some((message) => message.role === 'folded')).toBe(true);
    expect(transcript.some((message) => message.role === 'compacted')).toBe(true);
    expect(provider.compactions).toBeGreaterThan(0);

    // Bounded: the working set stops growing while the transcript does not.
    expect(active.length).toBeLessThan(transcript.length);
    expect(transcript.length).toBeGreaterThan(TURNS * 3);

    // Nothing silently lost: every turn the user sent is still in the
    // transcript, including the ones folding and compaction replaced.
    const userTexts = new Set(
      transcript
        .filter((message) => message.role === 'user')
        .flatMap((message) =>
          message.content.map((part) => (part.type === 'text' ? part.text : '')),
        ),
    );
    for (let turn = 1; turn <= TURNS; turn += 1) {
      expect(userTexts.has(`request ${String(turn)}`)).toBe(true);
    }

    // Replay is the source of truth: reopening from storage alone must rebuild
    // the identical working set, reductions included.
    const reopened = await Session.open(database, new RuleProvider(), MODEL, {
      context: { contextWindow: CONTEXT_WINDOW, tools: { work: workTool() } },
      sessionId: 'long-run',
      systemPrompt: 'system',
    });

    expect(reopened.getTranscript()).toEqual(transcript);
    expect(reopened.getHistory()).toEqual(active);
    await reopened.stop();
  });

  test('keeps every request the model saw growing only at the suffix between reductions', async () => {
    const database = await openDatabase();
    const provider = new RuleProvider();
    const session = await Session.open(database, provider, MODEL, {
      context: { contextWindow: CONTEXT_WINDOW, tools: { work: workTool() } },
      systemPrompt: 'system',
    });

    await drive(session, 40);
    await session.stop();

    let resets = 0;
    for (let index = 1; index < provider.requests.length; index += 1) {
      const previous = provider.requests[index - 1] ?? [];
      const current = provider.requests[index] ?? [];

      // A reduction replaces active history, which is the one legal way for the
      // head to change. Everywhere else the earlier request must still be a
      // prefix of the later one, message for message.
      const grewAtSuffix =
        current.length >= previous.length &&
        previous.every((message, position) => message.messageId === current[position]?.messageId);

      if (!grewAtSuffix) resets += 1;
    }

    // The law is not "the head rarely changes" — under sustained pressure it
    // changes constantly, because staying under the ceiling requires reducing
    // every turn. The law is that *only* a reduction may change it.
    const reductions = session
      .getTranscript()
      .filter((message) => message.role === 'compacted' || message.role === 'folded').length;

    expect(resets).toBeGreaterThan(0);
    expect(resets).toBeLessThanOrEqual(reductions);
  });

  test('the stored transcript is what replays, not anything held in memory', async () => {
    const database = await openDatabase();
    const session = await Session.open(database, new RuleProvider(), MODEL, {
      context: { contextWindow: CONTEXT_WINDOW, tools: { work: workTool() } },
      sessionId: 'durable',
      systemPrompt: 'system',
    });

    await drive(session, 60);
    await session.stop();

    // Read through a store this session never touched: a reduction that only
    // existed in memory would be missing here and nowhere else.
    const stored = await new SessionStore(database).load('durable');

    expect(stored?.messages).toEqual([...session.getTranscript()]);
    expect(stored?.messages.some((message) => message.role === 'folded')).toBe(true);
    expect(stored?.messages.some((message) => message.role === 'compacted')).toBe(true);
  });

  test('folds before it compacts even with no context window configured', async () => {
    const database = await openDatabase();
    const provider = new RuleProvider();
    const session = await Session.open(database, provider, MODEL, {
      // No contextWindow: the default an agent gets when nobody configures one.
      context: { tools: { work: workTool() } },
      systemPrompt: 'system',
    });

    await drive(session, 60);
    await session.stop();

    const transcript = session.getTranscript();
    const folds = transcript.filter((message) => message.role === 'folded').length;
    const compactions = transcript.filter((message) => message.role === 'compacted').length;

    // Law 2, both halves. Folding is deterministic and runs on its own
    // schedule, so it happens. Compaction is budget-triggered, and there is no
    // budget here, so it must not happen at all — summarizing lossily on a
    // guess is the failure this configuration used to have.
    expect(folds).toBeGreaterThan(0);
    expect(compactions).toBe(0);
  });
});
