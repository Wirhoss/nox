import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { HistorySearchToolSet } from './search';
import { Transcript } from './transcript';

import type { Message, MessageContent } from './message';

const AT = new Date('2025-01-01T00:00:00.000Z');

function user(messageId: string, text: string): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt: AT,
    messageId,
    origin: testOrigin(),
    role: 'user',
  };
}

function toolResponse(messageId: string, trackId: string, text: string): Message {
  return {
    createdAt: AT,
    execution: 'immediate',
    messageId,
    name: 'work',
    response: [{ text, type: 'text' }],
    role: 'toolResponse',
    trackId,
    trust: 'untrusted',
  };
}

async function call(
  tools: HistorySearchToolSet,
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  const execution = tools.prepare(name, params);
  if (execution.type !== 'immediate') throw new Error('Expected an immediate execution.');

  const content: MessageContent[] = await execution.run({ abortSignal: AbortSignal.abort() });
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

describe('search_history', () => {
  test('finds content the active context no longer holds', async () => {
    const transcript = new Transcript([
      user('u1', 'the deploy key lives at /etc/nox/deploy_ed25519'),
      user('u2', 'unrelated chatter about lunch'),
    ]);
    const tools = new HistorySearchToolSet(transcript);

    const found = await call(tools, 'search_history', { query: 'deploy_ed25519' });

    // The whole point of the tool: recovering an exact anchor from the
    // permanent transcript rather than guessing or asking the user again.
    expect(found).toContain('deploy_ed25519');
  });

  test('stays within its character budget instead of undoing a reduction', async () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      user(`u${String(index)}`, `repeated marker ${'padding '.repeat(60)}`),
    );
    const transcript = new Transcript(messages, { maxSearchCharacters: 1_200 });
    const tools = new HistorySearchToolSet(transcript);

    const found = await call(tools, 'search_history', { limit: 10, query: 'marker' });

    // Retrieval that quietly reclaimed the space folding and compaction freed
    // would defeat both of them, so the budget is enforced and reported.
    expect(found.length).toBeLessThan(2_000);
    expect(found).toContain('omitted');
  });

  test('an empty transcript answers with nothing rather than failing', async () => {
    const tools = new HistorySearchToolSet(new Transcript([]));

    expect(await call(tools, 'search_history', { query: 'anything' })).toBe('');
  });
});

describe('read_tool_result', () => {
  test('returns a result by track ID', async () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'exit code 0, 12 files')]);
    const tools = new HistorySearchToolSet(transcript);

    const found = await call(tools, 'read_tool_result', { trackId: 'track-1' });

    expect(found).toContain('exit code 0, 12 files');
    expect(found).toContain('track-1');
  });

  test('truncates a long result and resumes from the offset it reports', async () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'A'.repeat(3_000))]);
    const tools = new HistorySearchToolSet(transcript);

    const first = await call(tools, 'read_tool_result', { maxCharacters: 500, trackId: 'track-1' });
    expect(first).toContain('Result truncated');

    const offset = Number(/Continue with offset (\d+)/.exec(first)?.[1]);
    expect(offset).toBe(500);

    const second = await call(tools, 'read_tool_result', {
      maxCharacters: 4_000,
      offset,
      trackId: 'track-1',
    });

    // Continuing where the first read stopped must not repeat or skip content.
    expect(second).not.toContain('Result truncated');
    expect(first.slice(0, offset) + second).toContain('A'.repeat(3_000));
  });

  test('names what it could not find instead of returning nothing', () => {
    const tools = new HistorySearchToolSet(new Transcript([]));

    expect(() => tools.prepare('read_tool_result', { trackId: 'missing' })).not.toThrow();
    expect(call(tools, 'read_tool_result', { trackId: 'missing' })).rejects.toThrow('missing');
  });

  test('refuses an offset past the end of the result', () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'short')]);
    const tools = new HistorySearchToolSet(transcript);

    expect(call(tools, 'read_tool_result', { offset: 9_999, trackId: 'track-1' })).rejects.toThrow(
      RangeError,
    );
  });
});
