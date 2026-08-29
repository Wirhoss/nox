import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { chunkMessage, isIndexable } from './chunk';

import type { Message } from '@nox/extension-api';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function user(text: string): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId: 'u1',
    origin: testOrigin(),
    role: 'user',
  };
}

function toolResponse(text: string, execution: 'deferredAck' | 'immediate'): Message {
  return {
    createdAt: CREATED_AT,
    execution,
    messageId: 'r1',
    name: 'work',
    response: [{ text, type: 'text' }],
    role: 'toolResponse',
    trackId: 'track-1',
    trust: 'untrusted',
  };
}

describe('isIndexable', () => {
  test('excludes the roles that are derived from indexed messages', () => {
    const compacted: Message = {
      compactedMessageIds: ['u1'],
      content: [{ text: 'summary', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'compact',
      role: 'compacted',
    };
    const folded: Message = {
      content: [{ text: 'summary', type: 'text' }],
      createdAt: CREATED_AT,
      foldedMessageIds: ['u1'],
      messageId: 'fold',
      role: 'folded',
    };
    const reasoning: Message = {
      content: [{ text: 'weighing options', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'think',
      role: 'reasoning',
    };

    // A fold and a compaction summarize messages that are themselves indexed,
    // so indexing them too returns the same fact twice and lets the lossy copy
    // outrank the original. Reasoning is not something the model should be able
    // to quote back to itself as record.
    expect(isIndexable(compacted)).toBeFalse();
    expect(isIndexable(folded)).toBeFalse();
    expect(isIndexable(reasoning)).toBeFalse();
  });

  test('excludes a tool response that has no result yet', () => {
    expect(isIndexable(toolResponse('ack only', 'deferredAck'))).toBeFalse();
    expect(isIndexable(toolResponse('the answer', 'immediate'))).toBeTrue();
  });

  test('excludes a content message with nothing in it', () => {
    expect(isIndexable(user(''))).toBeFalse();
    expect(isIndexable(user('something'))).toBeTrue();
  });
});

describe('chunkMessage', () => {
  test('yields nothing at all for a message that is not indexable', () => {
    expect(chunkMessage(toolResponse('ack only', 'deferredAck'))).toEqual([]);
  });

  test('splits long text and numbers every piece', () => {
    const chunks = chunkMessage(user('x'.repeat(2_500)), 1_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain(`Content chunk 1 of ${String(chunks.length)}`);
    expect(chunks.at(-1)).toContain(`Content chunk ${String(chunks.length)} of`);
  });

  test('repeats the identity on every chunk so a hit read alone still says whose it is', () => {
    const chunks = chunkMessage(toolResponse('A'.repeat(2_500), 'immediate'), 1_000);

    // A search returns one chunk, not the message. Without the header on each
    // one, the reader gets text with no track ID to go read the rest of and no
    // way to tell a tool result from something the user said.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).toContain('Track ID: track-1');
      expect(chunk).toContain('Message ID: r1');
    }
  });

  test('keeps the whole text across the split, with nothing dropped or repeated', () => {
    const body = Array.from({ length: 300 }, (_, index) => `line-${String(index)}`).join('\n');
    const chunks = chunkMessage(user(body), 200);

    const rejoined = chunks
      .map((chunk) => chunk.slice(chunk.indexOf('Content:\n') + 'Content:\n'.length))
      .join('');
    expect(rejoined).toBe(body);
  });
});
