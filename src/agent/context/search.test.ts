import {
  describe,
  expect,
  test,
} from 'bun:test';

import { HistorySearch } from './search';

import type { Message } from '../../provider';
import type { ImmediateTool } from '../../tool';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const toolContext = { abortSignal: new AbortController().signal };

function user(messageId: string, text: string): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    messageId,
    role: 'user',
  };
}

function immediateTool(search: HistorySearch, name: string): ImmediateTool {
  const tool = search.tools[name];
  if (tool === undefined || tool.type !== 'immediate') {
    throw new Error(`Expected immediate tool: ${name}`);
  }
  return tool;
}

describe('HistorySearch', () => {
  test('builds identical search chunks during construction and append', async () => {
    const messages = [
      user('first', 'alpha '.repeat(80)),
      user('second', 'needle beta '.repeat(80)),
    ];
    const restored = new HistorySearch(messages, { chunkSize: 120 });
    const live = new HistorySearch([], { chunkSize: 120 });
    for (const message of messages) live.append(message);

    const restoredTool = immediateTool(restored, 'search_history');
    const liveTool = immediateTool(live, 'search_history');
    const parameters = { limit: 5, query: 'needle beta' };

    expect(await restoredTool.call(parameters, toolContext))
      .toEqual(await liveTool.call(parameters, toolContext));
  });

  test('rejects duplicate message IDs on construction and append', () => {
    const duplicate = user('duplicate', 'second');
    expect(() => new HistorySearch([
      user('duplicate', 'first'),
      duplicate,
    ], { chunkSize: 1000 })).toThrow('Duplicate message ID: duplicate.');

    const search = new HistorySearch([user('duplicate', 'first')], { chunkSize: 1000 });
    expect(() => search.append(duplicate)).toThrow('Duplicate message ID: duplicate.');
    expect(search.history).toHaveLength(1);
  });

  test('keeps non-indexable events in full history', () => {
    const search = new HistorySearch([], { chunkSize: 1000 });
    search.append({
      anchorMessageId: 'assistant',
      content: [{ text: 'fold summary', type: 'text' }],
      createdAt,
      foldedMessageIds: ['call', 'response'],
      messageId: 'fold',
      role: 'folded',
    });

    expect(search.history.map((message) => message.messageId)).toEqual(['fold']);
  });

  test('paginates large tool results', async () => {
    const search = new HistorySearch([{
      createdAt,
      execution: 'immediate',
      messageId: 'response',
      name: 'large_result',
      response: [{ text: 'result '.repeat(1000), type: 'text' }],
      role: 'toolResponse',
      trackId: 'track-large',
    }], { chunkSize: 1000 });
    const tool = immediateTool(search, 'read_tool_result');

    const first = await tool.call({
      maxCharacters: 400,
      offset: 0,
      trackId: 'track-large',
    }, toolContext);
    const firstText = first[0]?.type === 'text' ? first[0].text : '';

    expect(firstText).toContain('[Result truncated. Continue with offset 400.');

    const second = await tool.call({
      maxCharacters: 400,
      offset: 400,
      trackId: 'track-large',
    }, toolContext);
    const secondText = second[0]?.type === 'text' ? second[0].text : '';
    expect(secondText).toContain('result');
  });
});
