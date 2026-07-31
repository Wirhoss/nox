import {
  describe,
  expect,
  test,
} from 'bun:test';

import { foldHistory } from './fold';

import type { Message } from '../../provider';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function assistant(messageId: string): Message {
  return {
    content: [{ text: messageId, type: 'text' }],
    createdAt,
    messageId,
    role: 'assistant',
  };
}

function toolCall(messageId: string, trackId = 'track-1'): Message {
  return {
    arguments: { path: '/tmp/example' },
    createdAt,
    messageId,
    name: 'read',
    role: 'toolCall',
    trackId,
  };
}

function toolResponse(messageId: string, trackId = 'track-1'): Message {
  return {
    createdAt,
    execution: 'immediate',
    messageId,
    name: 'read',
    response: [{ text: 'result', type: 'text' }],
    role: 'toolResponse',
    trackId,
  };
}

describe('foldHistory', () => {
  test('uses the assistant before a partial fold range as its anchor', () => {
    const history = [
      assistant('assistant-before'),
      toolCall('call'),
      toolResponse('response'),
      assistant('assistant-after'),
    ];

    const result = foldHistory(history, 'call', 'response');

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    if (event === undefined) throw new Error('Expected one fold event.');
    expect(event.anchorMessageId).toBe('assistant-before');
    expect(result.history.map((message) => message.messageId)).toEqual([
      'assistant-before',
      event.messageId,
      'assistant-after',
    ]);
  });

  test('flushes a completed tool round at the end of the range', () => {
    const history = [
      assistant('assistant'),
      toolCall('call'),
      toolResponse('response'),
    ];

    const result = foldHistory(history);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.foldedMessageIds).toEqual(['call', 'response']);
  });

  test('renders every call and response with a duplicate track ID', () => {
    const history = [
      assistant('assistant'),
      toolCall('call-one', 'duplicate-track'),
      toolResponse('response-one', 'duplicate-track'),
      toolCall('call-two', 'duplicate-track'),
      toolResponse('response-two', 'duplicate-track'),
    ];

    const result = foldHistory(history);
    const event = result.events[0];
    if (event === undefined) throw new Error('Expected fold event.');
    const content = event.content[0];
    if (content?.type !== 'text') throw new Error('Expected text fold content.');

    expect(event.foldedMessageIds).toEqual([
      'call-one',
      'response-one',
      'call-two',
      'response-two',
    ]);
    expect(content.text.match(/Tool Name: read/g)).toHaveLength(2);
    expect(content.text.match(/Response Size:/g)).toHaveLength(2);
  });

  test('records unmatched tool responses in the fold placeholder', () => {
    const history = [
      assistant('assistant'),
      toolResponse('orphan-response', 'orphan-track'),
      assistant('next-assistant'),
    ];

    const result = foldHistory(history, 'orphan-response', 'orphan-response');
    const content = result.events[0]?.content[0];

    expect(content?.type).toBe('text');
    if (content?.type !== 'text') throw new Error('Expected text fold content.');
    expect(content.text).toContain('Unmatched Tool Response: read');
    expect(content.text).toContain('Track Id: orphan-track');
  });
});
