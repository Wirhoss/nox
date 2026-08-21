import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions';

import type { PermissionResolution, RiskSignal } from '../../tool/gate';
import type { ToolRisk } from '../../tool/tool';

const gateDecisions = sqliteTable(
  'gate_decisions',
  {
    createdAt: integer('created_at').notNull(),
    decidedBy: text('decided_by').notNull(),
    decisionId: text('decision_id').primaryKey(),
    params: text('params', { mode: 'json' }).$type<Readonly<Record<string, unknown>>>().notNull(),
    preview: text('preview'),
    reason: text('reason').notNull(),
    resolution: text('resolution').$type<PermissionResolution['resolution']>(),
    resolvedAt: integer('resolved_at'),
    risk: text('risk', { mode: 'json' }).$type<ToolRisk>(),
    scope: text('scope').$type<'once' | 'session'>(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    signals: text('signals', { mode: 'json' }).$type<readonly RiskSignal[]>().notNull(),
    title: text('title').notNull(),
    toolName: text('tool_name').notNull(),
    toolSetId: text('tool_set_id').notNull(),
    trackId: text('track_id').notNull(),
    verdict: text('verdict').$type<'allow' | 'deny' | 'escalate'>().notNull(),
  },
  (table) => [
    index('gate_decisions_session_created_idx').on(table.sessionId, table.createdAt),
    index('gate_decisions_track_idx').on(table.sessionId, table.trackId),
  ],
);

type GateDecisionRow = typeof gateDecisions.$inferSelect;
type GateDecisionRowInsert = typeof gateDecisions.$inferInsert;

export { gateDecisions };

export type { GateDecisionRow, GateDecisionRowInsert };
