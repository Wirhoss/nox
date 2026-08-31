import { bindTool, ToolSet } from '@nox/extension-api';
import { z } from 'zod';

import {
  HISTORY_READ_AUTHORITY,
  HISTORY_SEARCH_AUTHORITY,
  HISTORY_SESSIONS_AUTHORITY,
  HISTORY_SESSIONS_SEARCH_AUTHORITY,
} from '../../auth/coreAuthorities';

import type { Transcript } from './transcript';
import type { MessageContentText, Tool } from '@nox/extension-api';

const DEFAULT_MAX_SEARCH_CHARACTERS = 6000;
const SEARCH_BUDGET_NOTE =
  '[More matches were omitted to stay within the history-search response budget. ' +
  'Narrow the query with a more exact keyword, path, symbol, error, or ID.]';

interface HistorySessionSummary {
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt: Date;
}

interface HistorySessionList {
  readonly entries: readonly HistorySessionSummary[];
  readonly total: number;
}

interface HistoryExcerpt {
  readonly sessionId: string;
  readonly text: string;
  readonly title?: string;
}

/**
 * Everything the history tools need from storage, and nothing else.
 *
 * A port rather than the store itself: the context has no business holding a
 * database handle, and the session is the only thing that knows which agent
 * these searches are allowed to be about. Binding the agent behind this
 * interface is what keeps it out of the tool schemas — no tool takes an agent
 * ID, so no model can name one.
 */
interface HistoryArchive {
  listSessions(limit: number, offset: number): Promise<HistorySessionList>;
  search(query: string, limit: number, sessionId?: string): Promise<readonly HistoryExcerpt[]>;
}

/**
 * These are handed to the model by the context itself rather than granted from
 * a blueprint, so nothing else would ever bind them to a set. They bind
 * themselves — without a subject they could not be authorized at all.
 */
const HISTORY_TOOL_SET_ID = 'nox.history';

/**
 * Every name this set can claim, whether or not it claims it right now.
 *
 * The reservation cannot depend on the archive: a name that is taken in
 * production but free in a context composed without storage is a collision
 * nobody discovers until the day it matters. Composing a tool called
 * `history_sessions_search` is refused either way.
 */
const HISTORY_TOOL_NAMES = Object.freeze([
  'history_read_result',
  'history_search',
  'history_sessions',
  'history_sessions_search',
] as const);

/**
 * Every tool below declares its name as this type, so a tool registered under a
 * name the list does not carry is a compile error rather than a reservation
 * with a hole in it. The list and the tools cannot drift apart in the direction
 * that matters.
 */
type HistoryToolName = (typeof HISTORY_TOOL_NAMES)[number];

const readToolResultSchema = z.object({
  maxCharacters: z
    .number()
    .int()
    .min(200)
    .max(4000)
    .default(4000)
    .describe('Maximum characters to return. Continue from the reported next offset if truncated.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset at which to start reading the result.'),
  trackId: z
    .string()
    .describe(
      'The track ID of the tool call whose result you want, as shown in the `Track ID` field ' +
        'of the tool call or of its folded/compacted placeholder.',
    ),
});

const searchHistorySchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe(
      'Maximum number of transcript excerpts to return. Keep it small; raise it only when the ' +
        'first search comes back empty or off-target.',
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'A short keyword query for the session transcript. Prefer exact anchors such as file ' +
        'paths, symbol names, error messages, commands, IDs, or quoted user wording.',
    ),
});

const listSessionsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum number of sessions to list, most recently active first.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of sessions to skip, to page further back through the list.'),
});

const searchSessionsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Maximum number of excerpts to return across all matching sessions.'),
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      'A short keyword query. Prefer exact anchors such as file paths, symbol names, error ' +
        'messages, commands, IDs, or wording you expect was used verbatim.',
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Restrict the search to one session, as reported by history_sessions. Omit it to search ' +
        'every session held with you.',
    ),
});

function formatSessionList(list: HistorySessionList, currentSessionId: string): string {
  if (list.entries.length === 0) return 'No sessions are stored for this agent.';

  const lines = list.entries.map((entry) => {
    const current = entry.sessionId === currentSessionId ? ' (this session)' : '';
    const title = entry.title ?? '(untitled)';
    return (
      `- ${entry.sessionId}${current} — ${title}` +
      `\n  started ${entry.createdAt.toISOString()}, last active ${entry.updatedAt.toISOString()}`
    );
  });

  return (
    `Showing ${String(list.entries.length)} of ${String(list.total)} sessions, ` +
    `most recently active first:\n${lines.join('\n')}`
  );
}

/**
 * Packs excerpts into the response budget.
 *
 * A hit is a whole chunk, and a chunk can be a thousand characters of tool
 * output, so a handful of them is enough to crowd out the working set that
 * asked for them. Truncating a hit would be worse than dropping it — half an
 * excerpt reads as a complete one — so whole hits are dropped and the reader is
 * told to narrow the query instead.
 */
function toBudgetedContent(
  excerpts: readonly HistoryExcerpt[],
  attribute: boolean,
  maxCharacters: number,
): MessageContentText[] {
  const hits: MessageContentText[] = [];
  let characterCount = 0;
  let omitted = false;

  for (const excerpt of excerpts) {
    const text = attribute
      ? `Session: ${excerpt.sessionId}` +
        (excerpt.title === undefined ? '' : ` (${excerpt.title})`) +
        `\n${excerpt.text}`
      : excerpt.text;

    if (characterCount + text.length > maxCharacters) {
      omitted = true;
      break;
    }
    hits.push({ text, type: 'text' });
    characterCount += text.length;
  }

  if (!omitted) return hits;

  while (hits.length > 0 && characterCount + SEARCH_BUDGET_NOTE.length > maxCharacters) {
    characterCount -= hits.pop()?.text.length ?? 0;
  }
  hits.push({ text: SEARCH_BUDGET_NOTE.slice(0, maxCharacters - characterCount), type: 'text' });
  return hits;
}

interface HistorySearchOptions {
  /**
   * Storage for the transcripts. Without it the messages held in memory are all
   * there is, so only `history_read_result` is offered — a search tool with no
   * index behind it would answer every question with silence, which reads to a
   * model as "it never happened".
   */
  archive?: HistoryArchive;
  maxSearchCharacters?: number;
  /** Which session is the current one, so a search can be scoped to it. */
  sessionId?: string;
}

class HistorySearchToolSet extends ToolSet {
  readonly #archive?: HistoryArchive;
  readonly #maxSearchCharacters: number;
  readonly #sessionId: string;
  readonly #transcript: Transcript;

  constructor(transcript: Transcript, options: HistorySearchOptions = {}) {
    super('History', 'Searches and reads this session and the ones before it.');
    this.#archive = options.archive;
    this.#maxSearchCharacters = options.maxSearchCharacters ?? DEFAULT_MAX_SEARCH_CHARACTERS;
    this.#sessionId = options.sessionId ?? '';
    this.#transcript = transcript;
    this.addTools();
  }

  protected addTools(): void {
    const readToolResult: Tool<typeof readToolResultSchema> = {
      authority: HISTORY_READ_AUTHORITY,
      description:
        'Read an earlier tool result by track ID. Results are bounded; if the response ' +
        'reports a next offset, call the tool again from that offset.',
      name: 'history_read_result' satisfies HistoryToolName,
      parameters: readToolResultSchema,
      prepare: ({ trackId, offset, maxCharacters }) => ({
        run: () => Promise.resolve(this.#transcript.readToolResult(trackId, offset, maxCharacters)),
        title: `Read tool result — ${trackId}`,
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(readToolResult, HISTORY_TOOL_SET_ID));

    const archive = this.#archive;
    if (archive === undefined) return;

    const searchHistory: Tool<typeof searchHistorySchema> = {
      authority: HISTORY_SEARCH_AUTHORITY,
      description:
        'Keyword-search the complete transcript of the session you are in, including messages ' +
        'removed from the active context by folding or compaction, and get back the ' +
        'best-matching excerpts. Use it to recover earlier facts, requirements, decisions, ' +
        'commands, errors, or exact identifiers instead of guessing or asking the user to ' +
        'repeat them.',
      name: 'history_search' satisfies HistoryToolName,
      parameters: searchHistorySchema,
      prepare: ({ query, limit }) => ({
        run: async () =>
          toBudgetedContent(
            await archive.search(query, limit, this.#sessionId),
            false,
            this.#maxSearchCharacters,
          ),
        title: `Search history — ${query}`,
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(searchHistory, HISTORY_TOOL_SET_ID));

    const listSessions: Tool<typeof listSessionsSchema> = {
      authority: HISTORY_SESSIONS_AUTHORITY,
      description:
        'List the sessions held with you, most recently active first, with their IDs, titles ' +
        'and timestamps. Use it to find out what you have worked on before, or to get a ' +
        'session ID to point history_sessions_search at.',
      name: 'history_sessions' satisfies HistoryToolName,
      parameters: listSessionsSchema,
      prepare: ({ limit, offset }) => ({
        run: async () => [
          {
            text: formatSessionList(await archive.listSessions(limit, offset), this.#sessionId),
            type: 'text' as const,
          },
        ],
        title: 'List sessions',
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(listSessions, HISTORY_TOOL_SET_ID));

    const searchSessions: Tool<typeof searchSessionsSchema> = {
      authority: HISTORY_SESSIONS_SEARCH_AUTHORITY,
      description:
        'Keyword-search the transcripts of the sessions held with you, this one included, and ' +
        'get back the best-matching excerpts with the session each came from. Use it to recover ' +
        'something said in an earlier conversation — a decision, a path, a preference the user ' +
        'stated once. Narrow it with sessionId when you already know which session.',
      name: 'history_sessions_search' satisfies HistoryToolName,
      parameters: searchSessionsSchema,
      prepare: ({ query, limit, sessionId }) => ({
        run: async () =>
          toBudgetedContent(
            await archive.search(query, limit, sessionId),
            true,
            this.#maxSearchCharacters,
          ),
        title: `Search sessions — ${query}`,
        type: 'immediate',
      }),
    };
    this.registerTool(bindTool(searchSessions, HISTORY_TOOL_SET_ID));
  }
}

export { HISTORY_TOOL_NAMES, HistorySearchToolSet };

export type {
  HistoryArchive,
  HistoryExcerpt,
  HistorySearchOptions,
  HistorySessionList,
  HistorySessionSummary,
};
