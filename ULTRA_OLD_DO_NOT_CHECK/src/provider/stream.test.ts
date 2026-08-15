import {
  expect,
  test,
} from 'bun:test';

import { ProviderError } from './error';
import { ProviderStream } from './stream';

import type { ProviderSourceEvent, ProviderStreamEvent } from './stream';

async function* sourceOf(
  events: ProviderSourceEvent[],
): AsyncGenerator<ProviderSourceEvent> {
  for (const event of events) yield event;
}

function sourceThatThrows(error: unknown): AsyncIterable<ProviderSourceEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
    }),
  };
}

test('ProviderStream normalizes unexpected source failures', async () => {
  const stream = new ProviderStream(
    sourceThatThrows(new Error('decoder exploded')),
    new AbortController().signal,
  );
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);

  const event = events[0];
  expect(event?.type).toBe('error');
  if (event?.type !== 'error') throw new Error('Expected a provider error event');
  expect(event.error).toBeInstanceOf(ProviderError);
  expect(event.error.code).toBe('provider_error');
  expect(event.error.message).toBe('decoder exploded');
  await expect(stream.completed).rejects.toBe(event.error);
});

test('ProviderStream owns message assembly and the turn clock', async () => {
  const stream = new ProviderStream(
    sourceOf([
      { text: 'thinking', type: 'reasoningFragment' },
      { text: 'Hello ', type: 'textFragment' },
      { text: 'there', type: 'textFragment' },
      {
        toolCall: {
          arguments: { city: 'Cartago' },
          name: 'weather',
          role: 'toolCall',
          trackId: 'call_1',
        },
        type: 'toolCall',
      },
      { type: 'end' },
    ]),
    new AbortController().signal,
  );
  const messages = await stream.completed;
  expect(messages.map((message) => message.role))
    .toEqual(['reasoning', 'assistant', 'toolCall']);

  // A provider never sets identity or time. The stream owns both, and the
  // stamps must be strictly increasing so later sorting preserves array order.
  const messageIds = messages.map((message) => message.messageId);
  expect(messageIds.every((messageId) => messageId.length > 0)).toBe(true);
  expect(new Set(messageIds).size).toBe(messageIds.length);

  const stamps = messages.map((message) => message.createdAt.getTime());
  expect(stamps[0]).toBeLessThan(stamps[1] ?? 0);
  expect(stamps[1]).toBeLessThan(stamps[2] ?? 0);
});

test('ProviderStream preserves errors classified by a provider', async () => {
  const expected = new ProviderError(
    'context_limit',
    'Context is too large',
    { provider: 'test' },
  );

  const stream = new ProviderStream(
    sourceThatThrows(expected),
    new AbortController().signal,
  );
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);

  const event = events[0];
  expect(event?.type).toBe('error');
  if (event?.type !== 'error') throw new Error('Expected a provider error event');
  expect(event.error).toBe(expected);
  await expect(stream.completed).rejects.toBe(expected);
});
