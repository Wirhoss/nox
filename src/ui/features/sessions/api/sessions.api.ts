import { z } from 'zod'

import { contentPartSchema } from '@/features/chat/api/chat.schemas'
import { requestJson } from '@/shared/api/http'

const principalSchema = z.object({ issuer: z.string(), subject: z.string() })
const sessionSchema = z.object({
  agentId: z.string().nullable(),
  createdAt: z.string().datetime(),
  sessionId: z.string(),
  title: z.string().optional(),
  updatedAt: z.string().datetime(),
})
const sessionAgentSchema = z.object({
  agentId: z.string().nullable(),
  lastSessionAt: z.string().datetime(),
  sessionCount: z.number().int().positive(),
})
const sessionAgentsSchema = z.object({ agents: z.array(sessionAgentSchema) })
const sessionPageSchema = z.object({
  entries: z.array(sessionSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

const messageBase = z.object({ createdAt: z.string().datetime(), messageId: z.string() })
const transcriptEntrySchema = z.discriminatedUnion('role', [
  messageBase.extend({ content: z.array(contentPartSchema), role: z.literal('assistant') }),
  messageBase.extend({ content: z.array(contentPartSchema), role: z.literal('reasoning') }),
  messageBase.extend({
    content: z.array(contentPartSchema),
    delivery: z.enum(['message', 'steer']).optional(),
    origin: z.object({ principal: principalSchema, transportMessageId: z.string() }),
    role: z.literal('user'),
  }),
  messageBase.extend({
    compactedMessageIds: z.array(z.string()),
    content: z.array(contentPartSchema),
    role: z.literal('compacted'),
  }),
  messageBase.extend({
    anchorMessageId: z.string(),
    content: z.array(contentPartSchema),
    foldedMessageIds: z.array(z.string()),
    role: z.literal('folded'),
  }),
  messageBase.extend({
    arguments: z.record(z.unknown()),
    name: z.string(),
    role: z.literal('toolCall'),
    trackId: z.string(),
  }),
  messageBase.extend({
    execution: z.enum(['deferredAck', 'deferredResult', 'immediate', 'permissionPending']),
    isError: z.boolean().optional(),
    name: z.string(),
    response: z.array(contentPartSchema),
    role: z.literal('toolResponse'),
    trackId: z.string(),
    trust: z.enum(['trusted', 'untrusted']),
  }),
])
const transcriptSchema = z.object({
  entries: z.array(transcriptEntrySchema),
  session: sessionSchema,
  total: z.number().int().nonnegative(),
})

const riskSignalSchema = z.object({
  code: z.string(),
  reason: z.string(),
  resource: z.string().optional(),
  severity: z.enum(['approval', 'deny', 'info', 'review']),
})
const toolRiskSchema = z.object({
  effects: z.array(
    z.enum([
      'authentication',
      'credential',
      'delete',
      'execute',
      'network',
      'payment',
      'privilege',
      'read',
      'upload',
      'write',
    ]),
  ),
  resources: z
    .array(
      z.object({
        kind: z.enum(['account', 'command', 'file', 'payment', 'url']),
        value: z.string(),
      }),
    )
    .optional(),
  reversible: z.boolean().optional(),
  volume: z.number().optional(),
})
const auditDecisionSchema = z.object({
  authority: z.string(),
  createdAt: z.string().datetime(),
  decidedBy: z.string(),
  decisionId: z.string(),
  matchedGrant: z.string().optional(),
  params: z.record(z.unknown()),
  preview: z.string().optional(),
  principal: principalSchema,
  reason: z.string(),
  resolution: z.enum(['aborted', 'approved', 'denied', 'timeout']).optional(),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: principalSchema.optional(),
  risk: toolRiskSchema.optional(),
  runId: z.string(),
  scope: z.enum(['once', 'session']).optional(),
  sessionId: z.string(),
  signals: z.array(riskSignalSchema).optional(),
  stage: z.enum(['authorization', 'gate']),
  title: z.string().optional(),
  toolName: z.string(),
  toolSetId: z.string(),
  trackId: z.string(),
  verdict: z.enum(['allow', 'deny', 'escalate']),
})
const auditActionSchema = z.object({
  authority: z.string(),
  createdAt: z.string().datetime(),
  decisions: z.array(auditDecisionSchema).min(1),
  responses: z.array(
    z.object({
      content: z.array(contentPartSchema),
      createdAt: z.string().datetime(),
      execution: z.enum(['deferredAck', 'deferredResult', 'immediate', 'permissionPending']),
      isError: z.boolean(),
      trust: z.enum(['trusted', 'untrusted']),
    }),
  ),
  runId: z.string(),
  sessionId: z.string(),
  title: z.string().optional(),
  toolName: z.string(),
  toolSetId: z.string(),
  trackId: z.string(),
})
const auditActionPageSchema = z.object({
  entries: z.array(auditActionSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

type SessionAgent = z.infer<typeof sessionAgentSchema>
type SessionSummary = z.infer<typeof sessionSchema>
type SessionPage = z.infer<typeof sessionPageSchema>
type SessionTranscript = z.infer<typeof transcriptSchema>
type SessionTranscriptEntry = z.infer<typeof transcriptEntrySchema>
type SessionAuditDecision = z.infer<typeof auditDecisionSchema>
type SessionAuditAction = z.infer<typeof auditActionSchema>
type SessionAuditPage = z.infer<typeof auditActionPageSchema>

interface SessionsApi {
  listAgents(accessToken: string): Promise<readonly SessionAgent[]>
  listSessions(accessToken: string, agentId: null | string): Promise<SessionPage>
  readAudit(accessToken: string, sessionId: string, offset?: number): Promise<SessionAuditPage>
  readSession(accessToken: string, sessionId: string): Promise<SessionSummary>
  readTranscript(accessToken: string, sessionId: string): Promise<SessionTranscript>
}

function authorization(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}` }
}

const sessionsApi: SessionsApi = {
  async listAgents(accessToken) {
    const response = await requestJson('/sessions/agents', sessionAgentsSchema, {
      headers: authorization(accessToken),
    })
    return response.agents
  },
  listSessions(accessToken, agentId) {
    const query = agentId === null ? '' : `?agentId=${encodeURIComponent(agentId)}`
    return requestJson(`/sessions${query}`, sessionPageSchema, {
      headers: authorization(accessToken),
    })
  },
  readAudit(accessToken, sessionId, offset = 0) {
    const path = `/sessions/${encodeURIComponent(sessionId)}/audit?limit=50&offset=${String(offset)}`
    return requestJson(path, auditActionPageSchema, { headers: authorization(accessToken) })
  },
  readSession(accessToken, sessionId) {
    return requestJson(`/sessions/${encodeURIComponent(sessionId)}`, sessionSchema, {
      headers: authorization(accessToken),
    })
  },
  readTranscript(accessToken, sessionId) {
    return requestJson(`/sessions/${encodeURIComponent(sessionId)}/transcript`, transcriptSchema, {
      headers: authorization(accessToken),
    })
  },
}

export { sessionsApi }

export type {
  SessionAgent,
  SessionAuditAction,
  SessionAuditDecision,
  SessionAuditPage,
  SessionPage,
  SessionsApi,
  SessionSummary,
  SessionTranscript,
  SessionTranscriptEntry,
}
