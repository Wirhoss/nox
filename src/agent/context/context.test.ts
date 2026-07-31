import {
  describe,
  expect,
  test,
} from 'bun:test';

import { Context } from './context';

import type { ChatProvider, Message } from '../../provider';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function message(messageId: string, role: 'assistant' | 'user'): Message {
  return {
    content: [{ text: messageId, type: 'text' }],
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
    trackId: 'track-1',
  };
}

function toolResponse(messageId: string): Message {
  return {
    createdAt,
    execution: 'immediate',
    messageId,
    name: 'search',
    response: [{ text: 'result', type: 'text' }],
    role: 'toolResponse',
    trackId: 'track-1',
  };
}

function compactProvider(content: string): ChatProvider {
  return {
    getMessageStream: () => ({
      completed: Promise.resolve([{
        content: [{ text: content, type: 'text' }],
        createdAt,
        messageId: 'provider-summary',
        role: 'assistant',
      }]),
    }),
  } as unknown as ChatProvider;
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
      fullHistory: [...context.getFullHistory()],
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
      fullHistory: [...context.getFullHistory()],
    });
    expect(restored.getHistory()).toEqual(context.getHistory());
  });

  test('does not compact when the provider returns only blank text', async () => {
    const context = new Context('system', compactProvider('   '), {
      compactGuardBeginning: 0,
      compactGuardEnd: 0,
      compactMinMessages: 1,
    });
    context.addMessage(message('user', 'user'));

    await context.compact();

    expect(context.getHistory().map((entry) => entry.messageId)).toEqual(['user']);
    expect(context.getFullHistory()).toHaveLength(1);
  });
});
