import {
  expect,
  test,
} from 'bun:test';

import { MessageSearchIndex } from './searchIndex';

import type { AssistantMessage } from '../../provider';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function assistant(messageId: string, text: string): AssistantMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    messageId,
    role: 'assistant',
  };
}

test('MessageSearchIndex matches the active history by id, not object identity', () => {
  const original = assistant('assistant_1', 'cartago weather forecast');
  const index = new MessageSearchIndex([original]);
  // A copy stands in for any message the active history rebuilt rather than
  // carried over — truncation and replay both hand back fresh objects.
  const copy = { ...original, content: [...original.content] };

  expect(index.search('cartago', [copy])).toEqual([]);
  expect(index.search('cartago', [copy], { avoidInCurrentHistory: false }))
    .toEqual([original]);
});

test('MessageSearchIndex rejects duplicate message ids', () => {
  const first = assistant('duplicate', 'first');
  const second = assistant('duplicate', 'second');

  expect(() => new MessageSearchIndex([first, second]))
    .toThrow('Duplicate message id: duplicate');

  const index = new MessageSearchIndex([first]);
  expect(() => index.append(second)).toThrow('Duplicate message id: duplicate');
});
