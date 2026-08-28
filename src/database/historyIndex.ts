import { sql } from 'drizzle-orm';

import { chunkMessage } from '../agent/context/chunk';

import type { NoxDrizzle, NoxTransaction } from './database';
import type { Message } from '@nox/extension-api';

/**
 * The searchable half of the transcript.
 *
 * FTS5 is the index rather than an in-process one because the corpus is every
 * message of every session an agent has ever held: rebuilding that in memory on
 * each boot costs more the longer Nox is useful, and a top-K over the whole
 * corpus cannot be filtered down to one session afterwards without silently
 * losing hits. Here the filter is part of the query, so the same index answers
 * "in this session" and "in any of mine" without ranking one against the other.
 *
 * `bm25()` is FTS5's default ranking function, so this is the same scoring the
 * transcript search has always used — `rank` is that score, negated, and lowest
 * ranks first.
 */
const HISTORY_FTS_TABLE = 'history_fts';

/**
 * `remove_diacritics 2` folds combining marks the way `BM25`'s own normalizer
 * does, so a query typed without accents still matches text written with them.
 */
const HISTORY_FTS_DDL =
  `CREATE VIRTUAL TABLE ${HISTORY_FTS_TABLE} USING fts5(` +
  'text, ' +
  'session_id UNINDEXED, ' +
  'message_id UNINDEXED, ' +
  'seq UNINDEXED, ' +
  'chunk_index UNINDEXED, ' +
  "tokenize = 'unicode61 remove_diacritics 2'" +
  ')';

/** Mirrors the `unicode61` tokenizer, so a query splits the way the text did. */
const QUERY_TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;

interface HistoryHit {
  readonly messageId: string;
  readonly score: number;
  readonly sessionId: string;
  readonly text: string;
  readonly title?: string;
}

interface HistorySearchQuery {
  readonly limit: number;
  readonly query: string;
  /** Restricts the search to one session. Omitted, every session of the agent is searched. */
  readonly sessionId?: string;
}

interface FtsRow {
  readonly message_id: string;
  readonly rank: number;
  readonly session_id: string;
  readonly text: string;
  readonly title: null | string;
}

/**
 * Rewrites free text as an FTS5 MATCH expression.
 *
 * A raw query cannot be handed to MATCH: `AND`, `NEAR`, `*`, `-`, `:` and an
 * unbalanced quote are all operators there, so a user's own words are a syntax
 * error waiting to happen — and one that would surface as a failed tool call
 * rather than as no results. Reducing the query to quoted terms joined by OR
 * removes every operator and matches how the ranking already behaves: any term
 * can match, and documents carrying more of the rarer ones score higher.
 */
function toMatchExpression(query: string): string | undefined {
  const terms = query.toLowerCase().match(QUERY_TOKEN_PATTERN);
  if (terms === null || terms.length === 0) return undefined;
  return terms.map((term) => `"${term}"`).join(' OR ');
}

/**
 * Indexes one message as part of the transaction that stores it.
 *
 * Same transaction, deliberately: a message that reached storage but not the
 * index is invisible to the only tool that can find it again, and nothing would
 * ever notice. Either both land or neither does.
 */
function indexMessage(tx: NoxTransaction, sessionId: string, message: Message, seq: number): void {
  const chunks = chunkMessage(message);
  for (const [chunkIndex, text] of chunks.entries()) {
    tx.run(
      sql`INSERT INTO history_fts (text, session_id, message_id, seq, chunk_index)
          VALUES (${text}, ${sessionId}, ${message.messageId}, ${seq}, ${chunkIndex})`,
    );
  }
}

function search(database: NoxDrizzle, agentId: string, request: HistorySearchQuery): HistoryHit[] {
  const match = toMatchExpression(request.query);
  if (match === undefined) return [];

  // The join to `sessions` is what scopes a search to its own agent: the index
  // carries no agent of its own, so the one recorded when the session was
  // created stays the single answer to who a transcript belongs to.
  const rows = database.all<FtsRow>(
    request.sessionId === undefined
      ? sql`SELECT history_fts.text, history_fts.session_id, history_fts.message_id,
                   sessions.title, history_fts.rank
            FROM history_fts
            JOIN sessions ON sessions.session_id = history_fts.session_id
            WHERE history_fts MATCH ${match} AND sessions.agent_id = ${agentId}
            ORDER BY history_fts.rank
            LIMIT ${request.limit}`
      : sql`SELECT history_fts.text, history_fts.session_id, history_fts.message_id,
                   sessions.title, history_fts.rank
            FROM history_fts
            JOIN sessions ON sessions.session_id = history_fts.session_id
            WHERE history_fts MATCH ${match}
              AND sessions.agent_id = ${agentId}
              AND history_fts.session_id = ${request.sessionId}
            ORDER BY history_fts.rank
            LIMIT ${request.limit}`,
  );

  return rows.map((row) => ({
    messageId: row.message_id,
    score: row.rank,
    sessionId: row.session_id,
    text: row.text,
    ...(row.title === null ? {} : { title: row.title }),
  }));
}

export { HISTORY_FTS_DDL, HISTORY_FTS_TABLE, indexMessage, search, toMatchExpression };

export type { HistoryHit, HistorySearchQuery };
