import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions';

import type { DecisionStage } from '../../auth/audit';
import type { PermissionResolution, RiskSignal } from '../../tool/gate';
import type { ToolRisk } from '../../tool/tool';

/**
 * Every decision that stood between a tool call and its execution, in one table.
 *
 * Authorization and the Gate answer different questions — may this principal use
 * this authority at all, and is this exact call safe — and both can be the reason
 * something did not happen. Splitting them across two tables would mean an
 * operator has to know which question was answered before they can look it up.
 * `stage` says which half wrote the row.
 *
 * Columns only one stage produces are nullable for that reason alone; the domain
 * types are exact, and a row that cannot become a record is refused on read.
 */
const decisions = sqliteTable(
  'decisions',
  {
    authority: text('authority').notNull(),
    createdAt: integer('created_at').notNull(),
    decidedBy: text('decided_by').notNull(),
    decisionId: text('decision_id').primaryKey(),
    /** The grant entry that allowed it, wildcard included. Authorization only. */
    matchedGrant: text('matched_grant'),
    params: text('params', { mode: 'json' }).$type<Readonly<Record<string, unknown>>>().notNull(),
    preview: text('preview'),
    principalIssuer: text('principal_issuer').notNull(),
    principalSubject: text('principal_subject').notNull(),
    reason: text('reason').notNull(),
    resolution: text('resolution').$type<PermissionResolution['resolution']>(),
    resolvedAt: integer('resolved_at'),
    /** Who answered an escalation. Always the principal whose run asked. */
    resolvedByIssuer: text('resolved_by_issuer'),
    resolvedBySubject: text('resolved_by_subject'),
    risk: text('risk', { mode: 'json' }).$type<ToolRisk>(),
    runId: text('run_id').notNull(),
    scope: text('scope').$type<'once' | 'session'>(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    signals: text('signals', { mode: 'json' }).$type<readonly RiskSignal[]>(),
    stage: text('stage').$type<DecisionStage>().notNull(),
    title: text('title'),
    toolName: text('tool_name').notNull(),
    toolSetId: text('tool_set_id').notNull(),
    trackId: text('track_id').notNull(),
    verdict: text('verdict').$type<'allow' | 'deny' | 'escalate'>().notNull(),
  },
  (table) => [
    index('decisions_session_created_idx').on(table.sessionId, table.createdAt),
    index('decisions_track_idx').on(table.sessionId, table.trackId),
    index('decisions_principal_idx').on(table.principalIssuer, table.principalSubject),
  ],
);

type DecisionRow = typeof decisions.$inferSelect;
type DecisionRowInsert = typeof decisions.$inferInsert;

export { decisions };

export type { DecisionRow, DecisionRowInsert };
