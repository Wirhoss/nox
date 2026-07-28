import {
  expect,
  test,
} from 'bun:test';

import { ChatProvider } from '../../provider';

import { Context } from './context';

import type {
  AssistantMessage,
  Message,
  ProviderSourceEvent,
  ToolCallMessage,
  ToolResponseMessage,
} from '../../provider';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

class SummaryProvider extends ChatProvider {
  constructor() {
    super({ baseUrl: 'https://summary.test' });
  }

  public override async fetchModelIds(): Promise<string[]> {
    return [];
  }

  protected override async *attempt(): AsyncGenerator<ProviderSourceEvent> {
    yield { text: 'Earlier work summary', type: 'textFragment' };
    yield { type: 'end' };
  }
}

function assistant(messageId: string, text: string): AssistantMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    messageId,
    role: 'assistant',
  };
}

function toolCall(messageId: string, trackId: string): ToolCallMessage {
  return {
    arguments: { city: 'Cartago' },
    createdAt,
    messageId,
    name: 'weather',
    role: 'toolCall',
    trackId,
  };
}

function toolResponse(
  messageId: string,
  trackId: string,
  execution: ToolResponseMessage['execution'] = 'immediate',
): ToolResponseMessage {
  return {
    createdAt,
    execution,
    messageId,
    name: 'weather',
    response: [{ text: 'Sunny', type: 'text' }],
    role: 'toolResponse',
    trackId,
  };
}

function reload(fullHistory: readonly Message[]): Context {
  return new Context('', new SummaryProvider(), { fullHistory: [...fullHistory] });
}

test('Context persists id-based compaction and rebuilds it independently of guard settings', async () => {
  const fullHistory: Message[] = [
    assistant('message_a', 'A'),
    assistant('message_b', 'B'),
    assistant('message_c', 'C'),
  ];
  const provider = new SummaryProvider();
  const context = new Context('', provider, {
    compactGuardBeginning: 0,
    compactGuardEnd: 0,
    compactMinMessages: 2,
    fullHistory,
  });

  await context.compact();

  expect(context.getFullHistory()).toHaveLength(4);
  expect(context.getHistory()).toHaveLength(1);
  const summary = context.getHistory()[0];
  expect(summary?.role).toBe('compaction');
  if (summary?.role !== 'compaction') throw new Error('Expected a compaction message');
  expect(summary.replacedMessageIds).toEqual([
    'message_a',
    'message_b',
    'message_c',
  ]);

  const rebuilt = new Context('', provider, {
    compactGuardBeginning: 99,
    compactGuardEnd: 99,
    compactMinMessages: 999,
    fullHistory: [...context.getFullHistory()],
  });

  expect(rebuilt.getHistory().map((message) => message.messageId))
    .toEqual([summary.messageId]);
});

test('a rebuilt session reproduces the live history exactly across folds and compaction', async () => {
  const context = new Context('', new SummaryProvider(), {
    compactGuardBeginning: 0,
    compactGuardEnd: 0,
    compactMinMessages: 2,
  });

  context.addMessage(assistant('a0', 'first answer'));
  context.addMessage(toolCall('tc1', 'call_1'));
  context.addMessage(toolResponse('tr1', 'call_1'));
  context.addMessage(assistant('a1', 'second answer'));
  context.fold({ fromMessageId: 'a0', toMessageId: 'a1' });

  context.addMessage(toolCall('tc2', 'call_2'));
  context.addMessage(toolResponse('tr2', 'call_2', 'deferredAck'));
  context.addMessage(toolResponse('tr2_late', 'call_2', 'deferredResult'));
  context.addMessage(assistant('a2', 'third answer'));
  context.fold({ fromMessageId: 'a1', toMessageId: 'a2' });

  await context.compact();
  context.addMessage(assistant('a3', 'fourth answer'));

  // The rebuilt array is what gets sent to the provider on the next request, so
  // any divergence is a full-session prompt-cache miss. Compare the messages
  // themselves, not just their ids.
  expect(reload(context.getFullHistory()).getHistory()).toEqual(context.getHistory());
});

test('a session that enables folding mid-conversation still rebuilds', () => {
  const context = new Context('', new SummaryProvider(), {});

  context.addMessage(assistant('a0', 'first answer'));
  context.addMessage(toolCall('tc1', 'call_1'));
  context.addMessage(toolResponse('tr1', 'call_1'));
  context.addMessage(assistant('a1', 'second answer'));
  context.addMessage(toolCall('tc2', 'call_2'));
  context.addMessage(toolResponse('tr2', 'call_2'));
  context.addMessage(assistant('a2', 'third answer'));

  // Folding switched on partway through: the whole backlog collapses at once.
  context.fold();

  expect(context.getHistory().map((message) => message.role))
    .toEqual(['assistant', 'fold', 'assistant', 'fold', 'assistant']);
  expect(context.getFullHistory().filter((event) => event.role === 'fold')).toHaveLength(2);
  expect(reload(context.getFullHistory()).getHistory()).toEqual(context.getHistory());
});

test('fold is a no-op when the range holds no tool traffic', () => {
  const context = new Context('', new SummaryProvider(), {});

  context.addMessage(assistant('a0', 'first answer'));
  context.addMessage(assistant('a1', 'second answer'));

  const before = context.getFullHistory().length;
  context.fold();

  expect(context.getFullHistory()).toHaveLength(before);
  expect(context.getHistory().map((message) => message.messageId)).toEqual(['a0', 'a1']);
});
