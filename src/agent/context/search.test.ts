import { describe, expect, test } from 'bun:test';

import { HISTORY_TOOL_NAMES, HistorySearchToolSet } from './search';
import { Transcript } from './transcript';

import type { HistoryArchive, HistoryExcerpt } from './search';
import type { Message, MessageContent } from '@nox/extension-api';

const AT = new Date('2025-01-01T00:00:00.000Z');
const THIS_SESSION = 'session-now';

interface ArchiveCall {
  readonly limit: number;
  readonly query: string;
  readonly sessionId?: string;
}

interface FakeArchive extends HistoryArchive {
  readonly calls: ArchiveCall[];
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

/**
 * Stands in for storage so these tests are about the tools and nothing else:
 * which of them exist, what scope they ask for, and how they spend the response
 * budget. Ranking and the SQL behind it are the store's own tests.
 */
function fakeArchive(
  excerpts: readonly HistoryExcerpt[] = [],
  sessions: { createdAt: Date; sessionId: string; title?: string; updatedAt: Date }[] = [],
): FakeArchive {
  const calls: ArchiveCall[] = [];
  return {
    calls,
    listSessions: (limit, offset) =>
      Promise.resolve({ entries: sessions.slice(offset, offset + limit), total: sessions.length }),
    search: (query, limit, sessionId) => {
      calls.push({ limit, query, ...(sessionId === undefined ? {} : { sessionId }) });
      return Promise.resolve(
        excerpts
          .filter(
            (excerpt) =>
              (sessionId === undefined || excerpt.sessionId === sessionId) &&
              excerpt.text.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, limit),
      );
    },
  };
}

function toolSet(archive?: HistoryArchive, transcript = new Transcript([])): HistorySearchToolSet {
  return new HistorySearchToolSet(transcript, {
    ...(archive === undefined ? {} : { archive }),
    sessionId: THIS_SESSION,
  });
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

describe('the history tool set', () => {
  test('offers no search at all when there is no archive behind it', () => {
    const tools = toolSet();

    // A search tool with nothing to search would answer every question with
    // silence, and silence reads to a model as "it never happened" — worse than
    // never having offered the tool.
    expect(Object.keys(tools.tools)).toEqual(['history_read_result']);
  });

  test('offers exactly the set of names it reserves, once an archive is present', () => {
    const tools = toolSet(fakeArchive());

    // Compared against the reserved list itself, not a copy of it: `Context`
    // refuses user tools by that list, so a name it carries that nothing
    // registers is a reservation over nothing, and the reverse is a hole.
    expect(Object.keys(tools.tools).sort()).toEqual([...HISTORY_TOOL_NAMES].sort());
  });
});

describe('history_search', () => {
  test('finds content the active context no longer holds', async () => {
    const tools = toolSet(
      fakeArchive([
        { sessionId: THIS_SESSION, text: 'the deploy key lives at /etc/nox/deploy_ed25519' },
      ]),
    );

    const found = await call(tools, 'history_search', { query: 'deploy_ed25519' });

    // The whole point of the tool: recovering an exact anchor from the
    // permanent transcript rather than guessing or asking the user again.
    expect(found).toContain('deploy_ed25519');
  });

  test('is scoped to the session it belongs to, with no way to widen it', async () => {
    const archive = fakeArchive([
      { sessionId: THIS_SESSION, text: 'marker here' },
      { sessionId: 'session-other', text: 'marker elsewhere' },
    ]);
    const tools = toolSet(archive);

    const found = await call(tools, 'history_search', { query: 'marker' });

    expect(archive.calls[0]?.sessionId).toBe(THIS_SESSION);
    expect(found).toContain('marker here');
    expect(found).not.toContain('elsewhere');
  });

  test('stays within its character budget instead of undoing a reduction', async () => {
    const excerpts = Array.from({ length: 40 }, (_, index) => ({
      sessionId: THIS_SESSION,
      text: `repeated marker ${String(index)} ${'padding '.repeat(60)}`,
    }));
    const tools = new HistorySearchToolSet(new Transcript([]), {
      archive: fakeArchive(excerpts),
      maxSearchCharacters: 1_200,
      sessionId: THIS_SESSION,
    });

    const found = await call(tools, 'history_search', { limit: 10, query: 'marker' });

    // Retrieval that quietly reclaimed the space folding and compaction freed
    // would defeat both of them, so the budget is enforced and reported.
    expect(found.length).toBeLessThan(2_000);
    expect(found).toContain('omitted');
  });

  test('an empty archive answers with nothing rather than failing', async () => {
    const tools = toolSet(fakeArchive());

    expect(await call(tools, 'history_search', { query: 'anything' })).toBe('');
  });
});

describe('history_sessions_search', () => {
  test('says which session each excerpt came from', async () => {
    const tools = toolSet(
      fakeArchive([
        { sessionId: 'session-old', text: 'we settled on port 8443', title: 'TLS rollout' },
      ]),
    );

    const found = await call(tools, 'history_sessions_search', { query: 'port' });

    // An excerpt with no session on it is unusable: the model cannot tell its
    // own past decision from a different conversation's, and cannot go read
    // more of whichever one it was.
    expect(found).toContain('session-old');
    expect(found).toContain('TLS rollout');
    expect(found).toContain('port 8443');
  });

  test('searches every session by default and one when told to', async () => {
    const archive = fakeArchive([
      { sessionId: THIS_SESSION, text: 'marker now' },
      { sessionId: 'session-old', text: 'marker then' },
    ]);
    const tools = toolSet(archive);

    const all = await call(tools, 'history_sessions_search', { query: 'marker' });
    expect(archive.calls[0]?.sessionId).toBeUndefined();
    expect(all).toContain('marker now');
    expect(all).toContain('marker then');

    const one = await call(tools, 'history_sessions_search', {
      query: 'marker',
      sessionId: 'session-old',
    });
    expect(archive.calls[1]?.sessionId).toBe('session-old');
    expect(one).not.toContain('marker now');
    expect(one).toContain('marker then');
  });
});

describe('history_sessions', () => {
  test('marks the session the agent is currently in', async () => {
    const tools = toolSet(
      fakeArchive(
        [],
        [
          { createdAt: AT, sessionId: THIS_SESSION, title: 'today', updatedAt: AT },
          { createdAt: AT, sessionId: 'session-old', title: 'last week', updatedAt: AT },
        ],
      ),
    );

    const found = await call(tools, 'history_sessions', {});

    // Without the marker the agent can spend a history_sessions_search call rediscovering
    // the conversation it is already having.
    expect(found).toContain(`${THIS_SESSION} (this session)`);
    expect(found).toContain('session-old — last week');
    expect(found).not.toContain('session-old (this session)');
  });

  test('reports the total behind the page it returned', async () => {
    const sessions = Array.from({ length: 5 }, (_, index) => ({
      createdAt: AT,
      sessionId: `session-${String(index)}`,
      updatedAt: AT,
    }));
    const tools = toolSet(fakeArchive([], sessions));

    const found = await call(tools, 'history_sessions', { limit: 2 });

    expect(found).toContain('Showing 2 of 5 sessions');
    expect(found).toContain('(untitled)');
  });

  test('says so plainly when there is nothing stored', async () => {
    const tools = toolSet(fakeArchive());

    expect(await call(tools, 'history_sessions', {})).toBe(
      'No sessions are stored for this agent.',
    );
  });
});

describe('history_read_result', () => {
  test('returns a result by track ID', async () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'exit code 0, 12 files')]);
    const tools = toolSet(fakeArchive(), transcript);

    const found = await call(tools, 'history_read_result', { trackId: 'track-1' });

    expect(found).toContain('exit code 0, 12 files');
    expect(found).toContain('track-1');
  });

  test('truncates a long result and resumes from the offset it reports', async () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'A'.repeat(3_000))]);
    const tools = toolSet(fakeArchive(), transcript);

    const first = await call(tools, 'history_read_result', {
      maxCharacters: 500,
      trackId: 'track-1',
    });
    expect(first).toContain('Result truncated');

    const offset = Number(/Continue with offset (\d+)/.exec(first)?.[1]);
    expect(offset).toBe(500);

    const second = await call(tools, 'history_read_result', {
      maxCharacters: 4_000,
      offset,
      trackId: 'track-1',
    });

    // Continuing where the first read stopped must not repeat or skip content.
    expect(second).not.toContain('Result truncated');
    expect(first.slice(0, offset) + second).toContain('A'.repeat(3_000));
  });

  test('names what it could not find instead of returning nothing', () => {
    const tools = toolSet(fakeArchive());

    expect(() => tools.prepare('history_read_result', { trackId: 'missing' })).not.toThrow();
    expect(call(tools, 'history_read_result', { trackId: 'missing' })).rejects.toThrow('missing');
  });

  test('refuses an offset past the end of the result', () => {
    const transcript = new Transcript([toolResponse('r1', 'track-1', 'short')]);
    const tools = toolSet(fakeArchive(), transcript);

    expect(
      call(tools, 'history_read_result', { offset: 9_999, trackId: 'track-1' }),
    ).rejects.toThrow(RangeError);
  });
});
