import { z } from 'zod'

const toolEffectSchema = z.enum([
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
])

const toolResourceSchema = z.object({
  kind: z.enum(['account', 'command', 'file', 'payment', 'url']),
  value: z.string(),
})

const toolRiskSchema = z.object({
  effects: z.array(toolEffectSchema),
  resources: z.array(toolResourceSchema).optional(),
  reversible: z.boolean().optional(),
  volume: z.number().optional(),
})

const riskSignalSchema = z.object({
  code: z.string(),
  reason: z.string(),
  resource: z.string().optional(),
  severity: z.enum(['approval', 'deny', 'info', 'review']),
})

const permissionRequestSchema = z.object({
  authority: z.string(),
  expiresAt: z.string().datetime(),
  params: z.record(z.unknown()),
  preview: z.string().optional(),
  reason: z.string(),
  requestId: z.string(),
  requestedAt: z.string().datetime(),
  risk: toolRiskSchema.optional(),
  runId: z.string(),
  sessionId: z.string(),
  signals: z.array(riskSignalSchema),
  title: z.string(),
  toolName: z.string(),
  toolSetId: z.string(),
})

const eventBase = z.object({
  conversationId: z.string(),
  turnId: z.string(),
})

const usageSchema = z.object({
  cacheReadTokens: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
})

const chatEventSchema = z.discriminatedUnion('type', [
  eventBase.extend({
    change: z.enum(['compacted', 'folded']),
    replacedMessageIds: z.array(z.string()),
    text: z.string(),
    type: z.literal('contextChange'),
  }),
  eventBase.extend({ text: z.string(), type: z.literal('error') }),
  eventBase.extend({ text: z.string(), type: z.literal('fragment') }),
  eventBase.extend({ text: z.string(), type: z.literal('message') }),
  eventBase.extend({ request: permissionRequestSchema, type: z.literal('permission') }),
  eventBase.extend({
    outcome: z.object({
      resolution: z.enum(['aborted', 'approved', 'denied', 'timeout']),
      scope: z.enum(['once', 'session']).optional(),
    }),
    requestId: z.string(),
    type: z.literal('permissionResolved'),
  }),
  eventBase.extend({ text: z.string(), type: z.literal('reasoning') }),
  eventBase.extend({ text: z.string(), type: z.literal('reasoningFragment') }),
  eventBase.extend({
    attempt: z.number().int().nonnegative(),
    delayMs: z.number().nonnegative(),
    text: z.string(),
    type: z.literal('retry'),
  }),
  eventBase.extend({
    durationMs: z.number().nonnegative(),
    status: z.enum(['aborted', 'completed', 'failed', 'maxIterations']),
    type: z.literal('runCompleted'),
    usage: usageSchema.optional(),
  }),
  eventBase.extend({
    modelId: z.string(),
    startedAt: z.string().datetime(),
    trigger: z.enum(['deferredResult', 'steer', 'user']),
    type: z.literal('runStarted'),
  }),
  eventBase.extend({
    arguments: z.record(z.unknown()),
    name: z.string(),
    trackId: z.string(),
    type: z.literal('toolCall'),
  }),
  eventBase.extend({
    execution: z.enum(['deferredAck', 'deferredResult', 'immediate', 'permissionPending']),
    isError: z.boolean(),
    name: z.string(),
    text: z.string(),
    trackId: z.string(),
    type: z.literal('toolResponse'),
  }),
  eventBase.extend({ type: z.literal('usage'), usage: usageSchema }),
])

const acceptedMessageSchema = z.object({ messageId: z.string().min(1) })
const acceptedDecisionSchema = z.object({ requestId: z.string().min(1) })

type AcceptedDecision = z.infer<typeof acceptedDecisionSchema>
type AcceptedMessage = z.infer<typeof acceptedMessageSchema>
type ChatEvent = z.infer<typeof chatEventSchema>
type ChatPermissionRequest = z.infer<typeof permissionRequestSchema>
type ChatUsage = z.infer<typeof usageSchema>
type PermissionOutcome = Extract<ChatEvent, { type: 'permissionResolved' }>['outcome']

export {
  acceptedDecisionSchema,
  acceptedMessageSchema,
  chatEventSchema,
  permissionRequestSchema,
}

export type {
  AcceptedDecision,
  AcceptedMessage,
  ChatEvent,
  ChatPermissionRequest,
  ChatUsage,
  PermissionOutcome,
}
