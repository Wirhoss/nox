import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ChatProvider } from '../../provider/provider';
import { TEST_AUTHORITY, testOrigin } from '../../testFixtures';
import { Context } from './context';
import { type Message, messageToString, type UserMessage } from './message';
import { TokenEstimator } from './tokens';

import type { ModelConfig, TextGenerateOptions } from '../../provider/config';
import type { ProviderSourceEvent } from '../../provider/stream';
import type { Tool } from '../../tool/tool';

const BASE_TIME = new Date('2025-01-01T00:00:00.000Z');

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test value to exist.');
  return value;
}

function textMessage(
  role: 'assistant' | 'reasoning' | 'user',
  messageId: string,
  text: string,
): Message {
  if (role === 'user') {
    return {
      content: [{ text, type: 'text' }],
      createdAt: BASE_TIME,
      messageId,
      origin: testOrigin(),
      role,
    };
  }
  return { content: [{ text, type: 'text' }], createdAt: BASE_TIME, messageId, role };
}

function bytes(messages: readonly Message[]): string[] {
  return messages.map(messageToString);
}

interface CapturedRequest {
  history: Message[];
  model?: ModelConfig;
  systemPrompt: string;
  tools: Tool[];
}

class SummaryProvider extends ChatProvider {
  public readonly requests: CapturedRequest[] = [];
  public readonly lifecycle: string[] = [];
  public maxConcurrent = 0;

  readonly #responses: string[];
  readonly #wait?: () => Promise<void>;
  #active = 0;

  constructor(responses: string[], wait?: () => Promise<void>) {
    super({ baseUrl: 'https://provider.invalid' });
    this.#responses = [...responses];
    this.#wait = wait;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    const requestIndex = this.requests.length;
    this.requests.push({ history: messageHistory, model: opts?.model, systemPrompt, tools });
    this.lifecycle.push(`start:${String(requestIndex)}`);
    this.#active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#active);
    try {
      await this.#wait?.();
      const response = this.#responses.shift() ?? '';
      if (response.length > 0) yield { text: response, type: 'textFragment' };
      yield { type: 'end' };
    } finally {
      this.#active--;
      this.lifecycle.push(`end:${String(requestIndex)}`);
    }
  }
}

describe('Context cache stability', () => {
  test('append only grows the suffix and keeps every settled byte and object stable', () => {
    const provider = new SummaryProvider([]);
    const context = new Context('stable system', provider, {
      fullHistory: [textMessage('user', 'u1', 'first'), textMessage('assistant', 'a1', 'second')],
    });
    const before = context.getHistory();
    const beforeBytes = bytes(before);
    const fullBefore = context.getFullHistory();

    context.addMessage(textMessage('user', 'u2', 'new suffix'));

    const after = context.getHistory();
    expect(Object.isFrozen(before)).toBeTrue();
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual([...before]);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(bytes(after.slice(0, 2))).toEqual(beforeBytes);
    expect(context.getFullHistory().slice(0, 2)).toEqual([...fullBefore]);
  });

  test('tools are one immutable, globally sorted and referentially stable prefix', () => {
    const parameters = z.object({ value: z.string() });
    const zebra: Tool<typeof parameters> = {
      authority: TEST_AUTHORITY,
      description: 'z',
      name: 'zebra',
      parameters,
      prepare: () => ({
        run: () => Promise.resolve([]),
        title: 'z',
        type: 'immediate',
      }),
    };
    const alpha: Tool<typeof parameters> = { ...zebra, description: 'a', name: 'alpha' };
    const context = new Context('system', new SummaryProvider([]), {
      tools: { zebra, alpha },
    });

    const first = context.getTools();
    const second = context.getTools();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.keys(first)).toEqual(['alpha', 'read_tool_result', 'search_history', 'zebra']);
    for (const name of Object.keys(first)) expect(second[name]).toBe(first[name]);
  });

  test('user tools cannot silently replace a history tool', () => {
    const parameters = z.object({});
    const conflicting: Tool<typeof parameters> = {
      authority: TEST_AUTHORITY,
      description: 'conflict',
      name: 'search_history',
      parameters,
      prepare: () => ({
        run: () => Promise.resolve([]),
        title: 'conflict',
        type: 'immediate',
      }),
    };

    expect(
      () =>
        new Context('system', new SummaryProvider([]), {
          tools: { search_history: conflicting },
        }),
    ).toThrow('conflicts with a context history tool');
  });
});

describe('Context compaction', () => {
  test('token guards preserve exactly the unaffected prefix and suffix', async () => {
    const messages = [
      textMessage('user', 'u1', 'stable beginning '.repeat(20)),
      textMessage('assistant', 'a1', 'old middle one '.repeat(80)),
      textMessage('user', 'u2', 'old middle two '.repeat(80)),
      textMessage('assistant', 'a2', 'recent suffix '.repeat(20)),
    ];
    const estimator = new TokenEstimator('', [], (text) => text.length);
    const beginningTokens = estimator.estimateMessage(requireValue(messages[0]));
    const endTokens = estimator.estimateMessage(requireValue(messages[3]));
    const provider = new SummaryProvider(['small handoff']);
    const compactionModel: ModelConfig = { modelId: 'compact-model', type: 'text' };
    const context = new Context('system', provider, {
      compactGuardBeginningTokens: beginningTokens,
      compactionModel,
      compactGuardEndTokens: endTokens,
      compactMinTokens: 1,
      // Small enough to be under pressure from the first message. Compaction is
      // budget-triggered, so without a window it is unreachable by design.
      contextWindow: 100,
      fullHistory: messages,
      tokenCounter: (text) => text.length,
    });
    const before = context.getHistory();
    const beforeFull = context.getFullHistory();

    const result = await context.compact();

    expect(result).toEqual({ compacted: true });
    expect(Object.isFrozen(result)).toBeTrue();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.model).toBe(compactionModel);
    expect(provider.requests[0]?.history.slice(0, -1).map((message) => message.messageId)).toEqual([
      'a1',
      'u2',
    ]);

    const after = context.getHistory();
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[3]);
    expect(messageToString(requireValue(after[0]))).toBe(messageToString(requireValue(before[0])));
    expect(messageToString(requireValue(after[2]))).toBe(messageToString(requireValue(before[3])));
    expect(after[1]?.role).toBe('compacted');
    expect(context.getFullHistory().slice(0, beforeFull.length)).toEqual([...beforeFull]);
  });

  test('a persisted transcript replays to a bit-perfect active history', async () => {
    const provider = new SummaryProvider(['handoff with exact FILE_NAME.ts anchor']);
    const original = new Context('system', provider, {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 100,
      fullHistory: [
        textMessage('user', 'u1', 'x'.repeat(2000)),
        textMessage('assistant', 'a1', 'y'.repeat(2000)),
      ],
      tokenCounter: (text) => text.length,
    });
    await original.compact();

    const replayed = new Context('system', new SummaryProvider([]), {
      fullHistory: original.getFullHistory(),
      tokenCounter: (text) => text.length,
    });

    expect(bytes(replayed.getHistory())).toEqual(bytes(original.getHistory()));
    expect(bytes(replayed.getFullHistory())).toEqual(bytes(original.getFullHistory()));
  });

  test('one oversized message can compact even when it exceeds both default token guards', async () => {
    const provider = new SummaryProvider(['small']);
    const context = new Context('system', provider, {
      contextWindow: 10_000,
      fullHistory: [textMessage('user', 'huge', 'x'.repeat(20_000))],
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(context.isUnderPressure()).toBeTrue();
    expect(await context.compact()).toEqual({ compacted: true });
    expect(context.getHistory()).toHaveLength(1);
    expect(context.getHistory()[0]?.role).toBe('compacted');
  });

  test('a summary that does not reduce tokens leaves both histories bit-perfect', async () => {
    const provider = new SummaryProvider(['larger '.repeat(1000)]);
    const context = new Context('system', provider, {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 10,
      fullHistory: [textMessage('user', 'u1', 'small')],
      tokenCounter: (text) => text.length,
    });
    const activeBefore = context.getHistory();
    const fullBefore = context.getFullHistory();

    expect(await context.compact()).toEqual({ compacted: false });
    expect(context.getHistory()).toEqual(activeBefore);
    expect(context.getHistory()[0]).toBe(activeBefore[0]);
    expect(context.getFullHistory()).toEqual(fullBefore);
  });

  test('an empty provider response is a strict no-op', async () => {
    const context = new Context('system', new SummaryProvider(['']), {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 100,
      fullHistory: [textMessage('user', 'u1', 'x'.repeat(1000))],
    });
    const activeBefore = context.getHistory();
    const fullBefore = context.getFullHistory();

    expect(await context.compact()).toEqual({ compacted: false });
    expect(context.getHistory()).toEqual(activeBefore);
    expect(context.getFullHistory()).toEqual(fullBefore);
  });

  test('provider input usage anchors pressure and only later changes use estimated deltas', () => {
    const context = new Context('system', new SummaryProvider([]), {
      contextWindow: 10_000,
      fullHistory: [textMessage('user', 'large', 'x'.repeat(20_000))],
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(context.isUnderPressure()).toBeTrue();

    const sentEstimate = context.getTokenEstimate();
    context.recordInputUsage(100, sentEstimate);
    expect(context.isUnderPressure()).toBeFalse();

    context.addMessage(textMessage('assistant', 'later', 'y'.repeat(7_000)));
    expect(context.isUnderPressure()).toBeTrue();
  });

  test('under pressure it folds settled traffic and leaves the loop in flight alone', async () => {
    const heavy = 'x'.repeat(9_000);
    const light = 'y'.repeat(400);
    const call = (id: string, track: string, payload: string): Message => ({
      arguments: { payload },
      createdAt: BASE_TIME,
      messageId: id,
      name: 'work',
      role: 'toolCall',
      trackId: track,
    });
    const response = (id: string, track: string, payload: string): Message => ({
      createdAt: BASE_TIME,
      execution: 'immediate',
      messageId: id,
      name: 'work',
      response: [{ text: payload, type: 'text' }],
      role: 'toolResponse',
      trackId: track,
    });

    const provider = new SummaryProvider([]);
    const context = new Context('system', provider, {
      contextWindow: 10_000,
      foldMinReductionRatio: 0.1,
      fullHistory: [
        textMessage('user', 'u1', 'first'),
        // A fold hangs its placeholder on the assistant turn that asked for the
        // work, so what it replaces must have one in front of it.
        textMessage('assistant', 'a0', 'calling'),
        call('c1', 't1', heavy),
        response('r1', 't1', heavy),
        // The model answered, so everything above it is consumed and settled.
        textMessage('assistant', 'a1', 'done'),
        textMessage('user', 'u2', 'second'),
        textMessage('assistant', 'a2', 'calling again'),
        // This pair belongs to a loop still in flight, and is small on purpose:
        // once the settled pair folds, pressure is gone, so reaching the lossy
        // path at all would mean the fold never happened.
        call('c2', 't2', light),
        response('r2', 't2', light),
      ],
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(context.isUnderPressure()).toBeTrue();

    const result = await context.compact();

    // Folding alone relieved it, so the lossy path was never reached.
    expect(result).toEqual({ compacted: false });
    expect(provider.requests).toHaveLength(0);

    const ids = context.getHistory().map((message) => message.messageId);
    expect(ids).toContain('c2');
    expect(ids).toContain('r2');
    expect(ids).not.toContain('c1');
    expect(ids).not.toContain('r1');
    expect(context.getHistory().some((message) => message.role === 'folded')).toBeTrue();
  });

  test('folding can relieve pressure before a separate compaction check', async () => {
    const provider = new SummaryProvider([]);
    const context = new Context('system', provider, {
      compactGuardEndTokens: 0,
      contextWindow: 30_000,
      foldMinReductionRatio: 0.1,
      fullHistory: [
        textMessage('assistant', 'anchor', 'ready'),
        {
          arguments: { payload: 'x'.repeat(12_000) },
          createdAt: BASE_TIME,
          messageId: 'call',
          name: 'work',
          role: 'toolCall',
          trackId: 'track',
        },
        {
          createdAt: BASE_TIME,
          execution: 'immediate',
          messageId: 'response',
          name: 'work',
          response: [{ text: 'y'.repeat(12_000), type: 'text' }],
          role: 'toolResponse',
          trackId: 'track',
        },
      ],
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(context.isUnderPressure()).toBeTrue();
    expect(await context.fold()).toBeTrue();
    expect(context.isUnderPressure()).toBeFalse();
    expect(await context.compact()).toEqual({ compacted: false });
    expect(provider.requests).toHaveLength(0);
    expect(context.getHistory().map((message) => message.role)).toEqual(['assistant', 'folded']);
  });

  test('compaction does not fold tool traffic on its own', async () => {
    const provider = new SummaryProvider(['small']);
    const context = new Context('system', provider, {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 10_000,
      foldMinReductionRatio: 0.01,
      fullHistory: [
        textMessage('assistant', 'anchor', 'ready'),
        {
          arguments: { payload: 'x'.repeat(8_000) },
          createdAt: BASE_TIME,
          messageId: 'call',
          name: 'work',
          role: 'toolCall',
          trackId: 'track',
        },
        {
          createdAt: BASE_TIME,
          execution: 'immediate',
          messageId: 'response',
          name: 'work',
          response: [{ text: 'y'.repeat(8_000), type: 'text' }],
          role: 'toolResponse',
          trackId: 'track',
        },
      ],
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(await context.compact()).toEqual({ compacted: true });
    expect(context.getFullHistory().some((message) => message.role === 'folded')).toBeFalse();
    expect(provider.requests).toHaveLength(1);
  });

  test('the append sink sees the compaction the context writes on its own', async () => {
    const appended: Message[] = [];
    const context = new Context('system', new SummaryProvider(['small']), {
      contextWindow: 10_000,
      fullHistory: [textMessage('user', 'huge', 'x'.repeat(20_000))],
      onAppend: (message) => appended.push(message),
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(await context.compact()).toEqual({ compacted: true });
    expect(appended.map((message) => message.role)).toEqual(['compacted']);
  });

  test('the append sink sees the fold the context writes on its own', async () => {
    const appended: Message[] = [];
    const context = new Context('system', new SummaryProvider([]), {
      compactGuardEndTokens: 0,
      contextWindow: 30_000,
      foldMinReductionRatio: 0.1,
      fullHistory: [
        textMessage('assistant', 'anchor', 'ready'),
        {
          arguments: { payload: 'x'.repeat(12_000) },
          createdAt: BASE_TIME,
          messageId: 'call',
          name: 'work',
          role: 'toolCall',
          trackId: 'track',
        },
        {
          createdAt: BASE_TIME,
          execution: 'immediate',
          messageId: 'response',
          name: 'work',
          response: [{ text: 'y'.repeat(12_000), type: 'text' }],
          role: 'toolResponse',
          trackId: 'track',
        },
      ],
      onAppend: (message) => appended.push(message),
      reserveForOutput: 2_000,
      tokenCounter: (text) => text.length,
    });

    expect(await context.fold()).toBeTrue();
    expect(appended.map((message) => message.role)).toEqual(['folded']);
  });

  test('the append sink sees ordinary appends exactly once', () => {
    const appended: Message[] = [];
    const context = new Context('system', new SummaryProvider([]), {
      fullHistory: [textMessage('user', 'rebuilt', 'from storage')],
      onAppend: (message) => appended.push(message),
    });

    expect(appended).toEqual([]);

    context.addMessage(textMessage('user', 'live', 'now'));
    expect(appended.map((message) => message.messageId)).toEqual(['live']);
  });

  test('explicit folding reports whether it changed the cache and replays bit-perfectly', async () => {
    const context = new Context('system', new SummaryProvider([]), {
      foldMinReductionRatio: 0.01,
      fullHistory: [
        textMessage('assistant', 'anchor', 'ready'),
        {
          arguments: { payload: 'x'.repeat(4000) },
          createdAt: BASE_TIME,
          messageId: 'call',
          name: 'work',
          role: 'toolCall',
          trackId: 'track',
        },
        {
          createdAt: BASE_TIME,
          execution: 'immediate',
          messageId: 'response',
          name: 'work',
          response: [{ text: 'y'.repeat(4000), type: 'text' }],
          role: 'toolResponse',
          trackId: 'track',
        },
        textMessage('assistant', 'suffix', 'unchanged'),
      ],
      tokenCounter: (text) => text.length,
    });
    const before = context.getHistory();

    expect(await context.fold('call', 'response')).toBeTrue();
    const folded = context.getHistory();
    expect(folded.map((message) => message.role)).toEqual(['assistant', 'folded', 'assistant']);
    expect(folded[0]).toBe(before[0]);
    expect(folded[2]).toBe(before[3]);
    expect(await context.fold()).toBeFalse();

    const replayed = new Context('system', new SummaryProvider([]), {
      fullHistory: context.getFullHistory(),
      tokenCounter: (text) => text.length,
    });
    expect(bytes(replayed.getHistory())).toEqual(bytes(folded));
  });

  test('adding a message while summarization is pending only appends a stable suffix', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new SummaryProvider(['small'], () => gate);
    const context = new Context('system', provider, {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 100,
      fullHistory: [textMessage('user', 'old', 'x'.repeat(2000))],
      tokenCounter: (text) => text.length,
    });

    const pending = context.compact();
    while (provider.requests.length === 0) await Promise.resolve();
    context.addMessage(textMessage('user', 'new', 'arrived during compaction'));
    const appended = context.getHistory()[1];
    release();
    await pending;

    const after = context.getHistory();
    expect(after.map((message) => message.role)).toEqual(['compacted', 'user']);
    expect(after[1]).toBe(appended);
    expect(after[1]?.messageId).toBe('new');
  });

  test('concurrent reductions are serialized', async () => {
    const provider = new SummaryProvider(['first', 'second'], async () => {
      await Bun.sleep(5);
    });
    const context = new Context('system', provider, {
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
      contextWindow: 100,
      fullHistory: [textMessage('user', 'u1', 'x'.repeat(3000))],
      tokenCounter: (text) => text.length,
    });

    await Promise.all([context.compact(), context.compact()]);

    expect(provider.maxConcurrent).toBe(1);
    expect(provider.lifecycle).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
  });
});

describe('Context snapshots', () => {
  test('ingress messages are copied, deeply frozen and detached from the caller', () => {
    const original = {
      content: [{ text: 'original', type: 'text' as const }],
      createdAt: new Date(BASE_TIME),
      messageId: 'u1',
      origin: testOrigin(),
      role: 'user' as const,
    };
    const context = new Context('system', new SummaryProvider([]));
    context.addMessage(original);
    const stored = context.getHistory()[0] as UserMessage;

    expect(stored).not.toBe(original);
    expect(Object.isFrozen(stored)).toBeTrue();
    expect(Object.isFrozen(stored.content)).toBeTrue();
    original.content[0] = { text: 'mutated caller value', type: 'text' };
    original.createdAt.setUTCFullYear(2030);
    expect(messageToString(stored)).toContain('original');
    expect(stored.createdAt.toISOString()).toBe(BASE_TIME.toISOString());
  });
});
