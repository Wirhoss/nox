import {
  expect,
  test,
} from 'bun:test';

import { ProviderError } from './error';
import { ChatProvider } from './provider';

import type { ProviderSourceEvent, ProviderStreamEvent } from './stream';

class FlakyProvider extends ChatProvider {
  public attempts = 0;

  constructor() {
    super({
      baseUrl: 'https://provider.test',
      maxRetries: 1,
      retryDelayMs: 0,
    });
  }

  public override async fetchModelIds(): Promise<string[]> {
    return [];
  }

  protected override async *attempt(): AsyncGenerator<ProviderSourceEvent> {
    this.attempts += 1;

    if (this.attempts === 1) {
      yield { text: 'discarded reasoning', type: 'reasoningFragment' };
      yield { text: 'discarded text', type: 'textFragment' };
      throw new ProviderError('connection', 'Socket closed');
    }

    yield { text: 'replacement reasoning', type: 'reasoningFragment' };
    yield { text: 'replacement text', type: 'textFragment' };
    yield { type: 'end' };
  }
}

test('ChatProvider retries connections and marks partial output for replacement', async () => {
  const provider = new FlakyProvider();
  const stream = provider.getMessageStream('', [], []);
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);

  expect(provider.attempts).toBe(2);
  expect(events.map((event) => event.type)).toEqual([
    'reasoningFragment',
    'textFragment',
    'retry',
    'reasoningFragment',
    'textFragment',
    'end',
  ]);

  const retry = events[2];
  expect(retry?.type).toBe('retry');
  if (retry?.type !== 'retry') throw new Error('Expected a retry event');
  expect(retry.attempt).toBe(1);
  expect(retry.delayMs).toBe(0);
  expect(retry.error.code).toBe('connection');
  expect(retry.resetOutput).toBe(true);

  const completed = await stream.completed;
  expect(completed).toHaveLength(2);
  expect(completed[0]).toMatchObject({
    content: [{ text: 'replacement reasoning', type: 'text' }],
    role: 'reasoning',
  });
  expect(completed[1]).toMatchObject({
    content: [{ text: 'replacement text', type: 'text' }],
    role: 'assistant',
  });
  // The discarded attempt must not leak its clock into the replacement turn.
  expect(completed[0]?.createdAt.getTime())
    .toBeLessThan(completed[1]?.createdAt.getTime() ?? 0);
});
