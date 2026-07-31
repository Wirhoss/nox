import {
  describe,
  expect,
  test,
} from 'bun:test';

import { HistorySearchToolSet } from './search';
import { Transcript } from './transcript';

import type { Message, MessageContent } from '../../provider';
import type { ToolSet } from '../../tool';
import type { TranscriptOptions } from './transcript';

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

function createTranscript(
  messages: readonly Message[],
  options: TranscriptOptions,
): { transcript: Transcript; tools: HistorySearchToolSet } {
  const transcript = new Transcript(messages, options);
  return { tools: new HistorySearchToolSet(transcript), transcript };
}

async function runTool(
  toolSet: ToolSet,
  name: string,
  params: unknown,
): Promise<MessageContent[]> {
  const execution = toolSet.prepare(name, params);
  if (execution.type !== 'immediate') {
    throw new Error(`Expected immediate execution: ${name}`);
  }
  return execution.run(toolContext);
}

describe('Transcript', () => {
  test('builds identical search chunks during construction and append', async () => {
    const messages = [
      user('first', 'alpha '.repeat(80)),
      user('second', 'needle beta '.repeat(80)),
    ];
    const restored = createTranscript(messages, { chunkSize: 120 });
    const live = createTranscript([], { chunkSize: 120 });
    for (const message of messages) live.transcript.append(message);

    const parameters = { limit: 5, query: 'needle beta' };

    expect(await runTool(restored.tools, 'search_history', parameters))
      .toEqual(await runTool(live.tools, 'search_history', parameters));
  });

  test('recovers from persisted duplicate IDs but rejects live duplicates', () => {
    const duplicate = user('duplicate', 'second');
    const { transcript } = createTranscript([
      user('duplicate', 'first'),
      duplicate,
    ], { chunkSize: 1000 });

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.duplicateMessageIds).toEqual(['duplicate']);
    expect(() => transcript.append(duplicate)).toThrow('Duplicate message ID: duplicate.');
    expect(transcript.messages).toHaveLength(1);
  });

  test('keeps non-indexable events in the log', () => {
    const { transcript } = createTranscript([], { chunkSize: 1000 });
    transcript.append({
      anchorMessageId: 'assistant',
      content: [{ text: 'fold summary', type: 'text' }],
      createdAt,
      foldedMessageIds: ['call', 'response'],
      messageId: 'fold',
      role: 'folded',
    });

    expect(transcript.messages.map((message) => message.messageId)).toEqual(['fold']);
  });

  test('enforces an aggregate search response budget', async () => {
    const { tools } = createTranscript([
      user('one', 'needle '.repeat(100)),
      user('two', 'needle '.repeat(100)),
    ], { chunkSize: 120, maxSearchCharacters: 350 });

    const response = await runTool(tools, 'search_history', { limit: 10, query: 'needle' });
    const text = response.map((part) => part.type === 'text' ? part.text : '').join('');

    expect(text.length).toBeLessThanOrEqual(350);
    expect(text).toContain('More matches were omitted');
  });

  test('returns immutable snapshots and reuses them until the next append', () => {
    const original = user('immutable', 'original');
    const { transcript } = createTranscript([original], { chunkSize: 1000 });
    const snapshot = transcript.messages;

    expect(transcript.messages).toBe(snapshot);
    expect(() => (snapshot as Message[]).push(user('extra', 'extra'))).toThrow();

    const stored = snapshot[0];
    if (stored?.role !== 'user') throw new Error('Expected user message.');
    const content = stored.content[0];
    if (content?.type !== 'text') throw new Error('Expected user text.');
    expect(() => {
      (content as { text: string }).text = 'changed';
    }).toThrow();
    expect(snapshot[0]).toEqual(original);

    transcript.append(user('later', 'later'));
    expect(transcript.messages).not.toBe(snapshot);
  });

  test('paginates large tool results', async () => {
    const { tools } = createTranscript([{
      createdAt,
      execution: 'immediate',
      messageId: 'response',
      name: 'large_result',
      response: [{ text: 'result '.repeat(1000), type: 'text' }],
      role: 'toolResponse',
      trackId: 'track-large',
    }], { chunkSize: 1000 });

    const first = await runTool(tools, 'read_tool_result', {
      maxCharacters: 400,
      offset: 0,
      trackId: 'track-large',
    });
    const firstText = first[0]?.type === 'text' ? first[0].text : '';

    expect(firstText).toContain('[Result truncated. Continue with offset 400.');

    const second = await runTool(tools, 'read_tool_result', {
      maxCharacters: 400,
      offset: 400,
      trackId: 'track-large',
    });
    const secondText = second[0]?.type === 'text' ? second[0].text : '';
    expect(secondText).toContain('result');
  });
});
