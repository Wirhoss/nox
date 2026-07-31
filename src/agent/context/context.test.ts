import {
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { Context } from './context';
import { MessageTooLargeError } from './errors';

import type { ChatProvider, Message } from '../../provider';
import type { Tool } from '../../tool';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const countCharacters = (text: string): number => text.length;

function message(messageId: string, role: 'assistant' | 'user', text = messageId): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    messageId,
    role,
  };
}

function toolCall(messageId: string): Message {
  return {
    arguments: { query: 'example' },
    createdAt,
    messageId,
    name: 'search',
    role: 'toolCall',
    trackId: messageId,
  };
}

function toolResponse(messageId: string, text = 'result'): Message {
  return {
    createdAt,
    execution: 'immediate',
    messageId,
    name: 'search',
    response: [{ text, type: 'text' }],
    role: 'toolResponse',
    trackId: messageId,
  };
}

function compactProvider(
  content: string,
  onRequest?: (history: readonly Message[]) => void,
): ChatProvider {
  return {
    getMessageStream: (_systemPrompt: string, history: readonly Message[]) => {
      onRequest?.(history);
      return {
        completed: Promise.resolve([{
          content: [{ text: content, type: 'text' }],
          createdAt,
          messageId: 'provider-summary',
          role: 'assistant',
        }]),
      };
    },
  } as unknown as ChatProvider;
}

function prefixTokens(): number {
  return new Context('system', compactProvider('summary'), {
    tokenCounter: countCharacters,
  }).getTokenEstimate();
}

function messageIds(history: readonly Message[]): string[] {
  return history.map((entry) => entry.messageId);
}

function immediateTool(name: string): Tool {
  return {
    description: name,
    executionType: 'immediate',
    name,
    parameters: z.object({}),
    prepare: () => ({ run: async () => [], title: name, type: 'immediate' }),
  };
}

describe('Context replay', () => {
  test('rebuilds the same active history after folding', async () => {
    const provider = compactProvider('summary');
    const context = new Context('system', provider, {});
    for (const entry of [
      message('assistant', 'assistant'),
      toolCall('call'),
      toolResponse('response'),
    ]) {
      context.addMessage(entry);
    }

    await context.fold();

    const restored = new Context('system', provider, {
      fullHistory: context.getFullHistory(),
    });
    expect(restored.getHistory()).toEqual(context.getHistory());
  });

  test('rebuilds the same active history after compaction', async () => {
    const provider = compactProvider('compacted summary');
    const context = new Context('system', provider, {
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
    });
    context.addMessage(message('user', 'user'));
    context.addMessage(message('assistant', 'assistant'));

    await context.compact();

    const restored = new Context('system', provider, {
      fullHistory: context.getFullHistory(),
    });
    expect(restored.getHistory()).toEqual(context.getHistory());
  });

  test('adds a synthetic final user request only to the compaction provider call', async () => {
    let providerHistory: readonly Message[] = [];
    const context = new Context('system', compactProvider('summary', (history) => {
      providerHistory = history;
    }), {
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
    });
    context.addMessage(message('assistant', 'assistant'));

    await context.compact();

    const final = providerHistory.at(-1);
    if (final?.role !== 'user' || final.content[0]?.type !== 'text') {
      throw new Error('Expected a trailing user request.');
    }
    expect(final.content[0].text).toBe('Produce the handoff now.');
    expect(context.getFullHistory().some((entry) => (
      entry.messageId.startsWith('compaction-request-')
    ))).toBe(false);

    const compacted = context.getHistory()[0];
    if (compacted?.role !== 'compacted') throw new Error('Expected a compacted message.');
    expect(compacted.compactedMessageIds).toEqual(['assistant']);
  });

  test('does not compact when the provider returns only blank text', async () => {
    const context = new Context('system', compactProvider('   '), {
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
    });
    context.addMessage(message('user', 'user'));

    await context.compact();

    expect(messageIds(context.getHistory())).toEqual(['user']);
    expect(context.getFullHistory()).toHaveLength(1);
  });
});

describe('Context pressure', () => {
  test('counts the history-search tool schemas in the token estimate', () => {
    expect(prefixTokens()).toBeGreaterThan(500);
  });

  test('folds before using the compaction provider under token pressure', async () => {
    let providerCalls = 0;
    const context = new Context('system', compactProvider('summary', () => {
      providerCalls++;
    }), {
      compactAtRatio: 1,
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
      contextWindow: prefixTokens() + 800,
      reserveForOutput: 0,
      tokenCounter: countCharacters,
    });
    context.addMessage(message('assistant', 'assistant'));
    context.addMessage(toolCall('call'));
    context.addMessage(toolResponse('response', 'large result '.repeat(200)));

    expect(context.isUnderPressure()).toBe(true);
    await context.compact();

    expect(providerCalls).toBe(0);
    expect(context.isUnderPressure()).toBe(false);
    expect(context.getHistory().some((entry) => entry.role === 'folded')).toBe(true);
  });

  test('leaves the most recent tool round intact when folding under pressure', async () => {
    const context = new Context('system', compactProvider('summary'), {
      compactAtRatio: 1,
      compactGuardBeginning: 0,
      compactGuardEnd: 2,
      compactMinMessages: 100,
      contextWindow: prefixTokens() + 800,
      reserveForOutput: 0,
      tokenCounter: countCharacters,
    });
    context.addMessage(message('assistant', 'assistant'));
    context.addMessage(toolCall('old-call'));
    context.addMessage(toolResponse('old-response', 'large result '.repeat(200)));
    context.addMessage(toolCall('recent-call'));
    context.addMessage(toolResponse('recent-response'));

    await context.compact();

    // The round the agent is about to reason about must survive the fold.
    expect(messageIds(context.getHistory()).slice(-2)).toEqual([
      'recent-call',
      'recent-response',
    ]);
    expect(context.getHistory().some((entry) => entry.role === 'folded')).toBe(true);
  });

  test('compacts based on token pressure rather than message count alone', async () => {
    let providerCalls = 0;
    const context = new Context('system', compactProvider('summary', () => {
      providerCalls++;
    }), {
      compactAtRatio: 1,
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
      contextWindow: prefixTokens() + 200,
      reserveForOutput: 0,
      tokenCounter: countCharacters,
    });
    context.addMessage(message('large-user', 'user', 'x'.repeat(1000)));

    await context.compact();

    expect(providerCalls).toBe(1);
    expect(context.getHistory()[0]?.role).toBe('compacted');
  });

  test('does nothing when no context window is configured', async () => {
    let providerCalls = 0;
    const context = new Context('system', compactProvider('summary', () => {
      providerCalls++;
    }), {});
    context.addMessage(message('large-user', 'user', 'x'.repeat(100_000)));

    await context.compact();

    expect(providerCalls).toBe(0);
    expect(context.isUnderPressure()).toBe(false);
  });
});

describe('Context ingress cap', () => {
  test('rejects live messages over the cap with a recoverable error', () => {
    const context = new Context('system', compactProvider('summary'), {
      maxMessageTokens: 300,
      tokenCounter: countCharacters,
    });

    let thrown: unknown;
    try {
      context.addMessage(message('oversized', 'user', 'x'.repeat(500)));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MessageTooLargeError);
    const error = thrown as MessageTooLargeError;
    expect(error.messageId).toBe('oversized');
    expect(error.maxMessageTokens).toBe(300);
    expect(error.estimatedTokens).toBeGreaterThan(300);
    expect(context.getHistory()).toHaveLength(0);
  });

  test('loads persisted history over the cap and reports it instead of failing', () => {
    const context = new Context('system', compactProvider('summary'), {
      fullHistory: [
        message('oversized', 'user', 'x'.repeat(500)),
        message('duplicate', 'assistant'),
        message('duplicate', 'assistant'),
      ],
      maxMessageTokens: 300,
      tokenCounter: countCharacters,
    });

    expect(messageIds(context.getHistory())).toEqual(['oversized', 'duplicate']);
    expect(context.getLoadDiagnostics()).toEqual({
      duplicateMessageIds: ['duplicate'],
      oversizedMessageIds: ['oversized'],
    });
  });
});

describe('Context encapsulation', () => {
  test('protects the active history from external mutation', () => {
    const context = new Context('system', compactProvider('summary'), {});
    const originalDate = new Date('2025-02-03T00:00:00.000Z');
    const original: Message = {
      content: [{ text: 'original', type: 'text' }],
      createdAt: originalDate,
      messageId: 'immutable',
      role: 'user',
    };
    context.addMessage(original);
    originalDate.setUTCFullYear(1999);

    const active = context.getHistory();
    expect(() => (active as Message[]).push(message('extra', 'user'))).toThrow();

    const stored = active[0];
    if (stored?.role !== 'user' || stored.content[0]?.type !== 'text') {
      throw new Error('Expected a stored user message.');
    }
    expect(stored.content[0].text).toBe('original');
    expect(() => stored.createdAt.setUTCFullYear(2000)).toThrow();
    expect(context.getHistory()[0]?.createdAt.toISOString()).toBe('2025-02-03T00:00:00.000Z');
  });

  test('exposes tools as a frozen, name-sorted record', () => {
    const context = new Context('system', compactProvider('summary'), {
      tools: {
        zulu: immediateTool('zulu'),
        alpha: immediateTool('alpha'),
      },
    });

    const tools = context.getTools();
    expect(Object.keys(tools)).toEqual(['alpha', 'zulu']);
    expect(() => {
      (tools as Record<string, unknown>)['external'] = undefined;
    }).toThrow();
    expect(context.getTools()).toBe(tools);
  });

  test('exposes history search as a query-only capability', () => {
    const context = new Context('system', compactProvider('summary'), {});
    const toolSet = context.getHistorySearchToolSet();
    const tools = toolSet.tools;

    expect(Object.keys(tools)).toEqual(['read_tool_result', 'search_history']);
    expect(() => {
      delete (tools as Record<string, unknown>)['search_history'];
    }).toThrow();
    expect(toolSet.tools).toBe(tools);
  });
});
