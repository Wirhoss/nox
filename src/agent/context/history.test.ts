import {
  expect,
  test,
} from 'bun:test';

import { applyCompaction, applyFold, foldHistory } from './history';

import type {
  AssistantMessage,
  CompactionMessage,
  Message,
  ToolCallMessage,
  ToolResponseMessage,
} from '../../provider';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function assistant(messageId: string, text: string): AssistantMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    messageId,
    role: 'assistant',
  };
}

function compaction(messageId: string, replacedMessageIds: string[]): CompactionMessage {
  return {
    content: [{ text: 'summary', type: 'text' }],
    createdAt,
    messageId,
    replacedMessageIds,
    role: 'compaction',
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

test('applyCompaction replaces the exact contiguous messages by id', () => {
  const history = [
    assistant('message_a', 'A'),
    assistant('message_b', 'B'),
    assistant('message_c', 'C'),
    assistant('message_d', 'D'),
  ];
  const summary = compaction('compaction_1', ['message_b', 'message_c']);

  expect(applyCompaction(history, summary)).toEqual([
    history[0]!,
    summary,
    history[3]!,
  ]);
});

test('applyCompaction supports nested compaction events', () => {
  const first = assistant('message_a', 'A');
  const second = assistant('message_b', 'B');
  const third = assistant('message_c', 'C');
  const fourth = assistant('message_d', 'D');
  const fifth = assistant('message_e', 'E');
  const firstSummary = compaction('compaction_1', ['message_b', 'message_c']);
  const secondSummary = compaction('compaction_2', ['compaction_1', 'message_d']);

  const afterFirst = applyCompaction(
    [first, second, third, fourth, fifth],
    firstSummary,
  );
  expect(applyCompaction(afterFirst, secondSummary)).toEqual([
    first,
    secondSummary,
    fifth,
  ]);
});

test('applyCompaction rejects missing or non-contiguous references', () => {
  const history = [
    assistant('message_a', 'A'),
    assistant('message_b', 'B'),
    assistant('message_c', 'C'),
  ];

  expect(() => applyCompaction(
    history,
    compaction('missing', ['message_b', 'unknown']),
  )).toThrow('references missing messages: unknown');
  expect(() => applyCompaction(
    history,
    compaction('non_contiguous', ['message_a', 'message_c']),
  )).toThrow('references a non-contiguous message range');
});

test('foldHistory replaces the tool group with a fold and leaves the anchor alone', () => {
  const anchor = assistant('assistant_anchor', 'I will check.');
  const next = assistant('assistant_next', 'It is sunny.');
  const history: Message[] = [
    anchor,
    toolCall('tool_call', 'call_1'),
    toolResponse('tool_response', 'call_1'),
    next,
  ];

  const { events, history: folded } = foldHistory(history);

  expect(events).toHaveLength(1);
  expect(events[0]?.anchorMessageId).toBe('assistant_anchor');
  expect(events[0]?.foldedMessageIds).toEqual(['tool_call', 'tool_response']);

  expect(folded.map((message) => message.role)).toEqual([
    'assistant',
    'fold',
    'assistant',
  ]);
  // The anchor is untouched: rendering the fold is the provider's decision.
  expect(folded[0]).toBe(anchor);
  expect(folded[2]).toBe(next);
});

test('replaying a recorded fold reproduces the live fold exactly', () => {
  const history: Message[] = [
    assistant('a0', 'first'),
    toolCall('tc1', 'call_1'),
    toolResponse('tr1', 'call_1'),
    assistant('a1', 'second'),
    toolCall('tc2', 'call_2'),
    toolResponse('tr2', 'call_2'),
    assistant('a2', 'third'),
  ];

  const { events, history: live } = foldHistory(history);
  expect(events).toHaveLength(2);

  let replayed: Message[] = [...history];
  for (const event of events) {
    replayed = applyFold(replayed, event);
  }

  // Byte-for-byte equality is the prompt-cache hit condition on reload.
  expect(replayed).toEqual(live);
});

test('foldHistory only folds inside the requested range', () => {
  const history: Message[] = [
    assistant('a0', 'first'),
    toolCall('tc1', 'call_1'),
    toolResponse('tr1', 'call_1'),
    assistant('a1', 'second'),
    toolCall('tc2', 'call_2'),
    toolResponse('tr2', 'call_2'),
    assistant('a2', 'third'),
  ];

  const { events, history: folded } = foldHistory(history, {
    fromMessageId: 'a1',
    toMessageId: 'a2',
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.anchorMessageId).toBe('a1');
  expect(folded.map((message) => message.messageId))
    .toEqual(['a0', 'tc1', 'tr1', 'a1', events[0]!.messageId, 'a2']);
});

test('foldHistory keeps deferred results out of the fold', () => {
  const history: Message[] = [
    assistant('a0', 'first'),
    toolCall('tc1', 'call_1'),
    toolResponse('tr1', 'call_1', 'deferredAck'),
    toolResponse('tr_late', 'call_1', 'deferredResult'),
    assistant('a1', 'second'),
  ];

  const { events, history: folded } = foldHistory(history);

  expect(events[0]?.foldedMessageIds).toEqual(['tc1', 'tr1']);
  expect(folded.map((message) => message.messageId))
    .toEqual(['a0', events[0]!.messageId, 'tr_late', 'a1']);
});

test('foldHistory refuses to fold a tool group that has no closing assistant message', () => {
  const history: Message[] = [
    assistant('a0', 'first'),
    toolCall('tc1', 'call_1'),
    toolResponse('tr1', 'call_1'),
  ];

  expect(() => foldHistory(history))
    .toThrow('Remaining tool call or response messages found after folding context.');
});

test('applyFold rejects a missing anchor or missing folded messages', () => {
  const history: Message[] = [
    assistant('a0', 'first'),
    toolCall('tc1', 'call_1'),
    toolResponse('tr1', 'call_1'),
    assistant('a1', 'second'),
  ];
  const { events } = foldHistory(history);
  const event = events[0]!;

  expect(() => applyFold([history[1]!, history[2]!, history[3]!], event))
    .toThrow(`references a missing anchor ${event.anchorMessageId}`);
  expect(() => applyFold([history[0]!, history[3]!], event))
    .toThrow('references missing messages: tc1, tr1');
});
