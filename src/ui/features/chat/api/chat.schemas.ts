import { z } from 'zod'

const artifactRefSchema = z.object({
  artifactId: z.string(),
  filename: z.string().optional(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
})
const contentSourceSchema = z.object({
  mediaType: z.string().optional(),
  type: z.literal('url'),
  url: z.string().url(),
})
const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ text: z.string(), type: z.literal('text') }),
  z.object({ artifact: artifactRefSchema, type: z.literal('artifact') }),
  z.object({ source: contentSourceSchema, type: z.literal('image') }),
  z.object({ source: contentSourceSchema, type: z.literal('audio') }),
  z.object({ source: contentSourceSchema, type: z.literal('video') }),
  z.object({ source: contentSourceSchema, type: z.literal('document') }),
])

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

const contextUsageSchema = z.object({
  compactAtTokens: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
  usedTokens: z.number().nonnegative(),
})

const chatEventSchema = z.discriminatedUnion('type', [
  eventBase.extend({
    change: z.enum(['compacted', 'folded']),
    replacedMessageIds: z.array(z.string()),
    text: z.string(),
    type: z.literal('contextChange'),
  }),
  eventBase.extend({ type: z.literal('contextUsage'), usage: contextUsageSchema }),
  eventBase.extend({ text: z.string(), type: z.literal('error') }),
  eventBase.extend({ text: z.string(), type: z.literal('fragment') }),
  eventBase.extend({
    content: z.array(contentPartSchema).optional(),
    text: z.string(),
    type: z.literal('message'),
  }),
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
  eventBase.extend({ title: z.string(), type: z.literal('title') }),
  eventBase.extend({
    arguments: z.record(z.unknown()),
    name: z.string(),
    trackId: z.string(),
    type: z.literal('toolCall'),
  }),
  eventBase.extend({
    content: z.array(contentPartSchema).optional(),
    execution: z.enum(['deferredAck', 'deferredResult', 'immediate', 'permissionPending']),
    isError: z.boolean(),
    name: z.string(),
    text: z.string(),
    trackId: z.string(),
    type: z.literal('toolResponse'),
  }),
  eventBase.extend({ type: z.literal('usage'), usage: usageSchema }),
])

const historyEntryBase = z.object({
  at: z.string().datetime(),
  messageId: z.string().min(1),
})

const historyEntrySchema = z.discriminatedUnion('type', [
  historyEntryBase.extend({
    change: z.enum(['compacted', 'folded']),
    replacedMessageIds: z.array(z.string()),
    text: z.string(),
    type: z.literal('contextChange'),
  }),
  historyEntryBase.extend({
    content: z.array(contentPartSchema).optional(),
    text: z.string(),
    type: z.literal('message'),
  }),
  historyEntryBase.extend({ text: z.string(), type: z.literal('reasoning') }),
  historyEntryBase.extend({
    arguments: z.record(z.unknown()),
    name: z.string(),
    trackId: z.string(),
    type: z.literal('toolCall'),
  }),
  historyEntryBase.extend({
    content: z.array(contentPartSchema).optional(),
    execution: z.enum(['deferredAck', 'deferredResult', 'immediate', 'permissionPending']),
    isError: z.boolean(),
    name: z.string(),
    text: z.string(),
    trackId: z.string(),
    type: z.literal('toolResponse'),
  }),
  historyEntryBase.extend({
    content: z.array(contentPartSchema).optional(),
    mode: z.enum(['message', 'steer']),
    principal: z.object({ issuer: z.string(), subject: z.string() }),
    text: z.string(),
    type: z.literal('userMessage'),
  }),
])

const chatHistorySchema = z.object({
  agentId: z.string(),
  contextUsage: contextUsageSchema.optional(),
  conversationId: z.string(),
  entries: z.array(historyEntrySchema),
  sessionId: z.string(),
})

const conversationSchema = z.object({
  agentId: z.string(),
  contextUsage: contextUsageSchema.optional(),
  conversationId: z.string(),
  sessionId: z.string(),
  startedAt: z.string().datetime(),
  state: z.enum(['closed', 'idle', 'running']),
  /** Absent while the session has not been named. */
  title: z.string().optional(),
  updatedAt: z.string().datetime(),
})
const conversationsSchema = z.object({ conversations: z.array(conversationSchema) })

const commandSchema = z.object({
  description: z.string(),
  name: z.string(),
  parameters: z.record(z.unknown()),
})
const commandsSchema = z.object({ commands: z.array(commandSchema) })

const acceptedCommandSchema = z.object({ command: z.string().min(1) })
const acceptedMessageSchema = z.object({ messageId: z.string().min(1) })
const acceptedDecisionSchema = z.object({ requestId: z.string().min(1) })

type ArtifactRef = z.infer<typeof artifactRefSchema>
type AcceptedCommand = z.infer<typeof acceptedCommandSchema>
type AcceptedDecision = z.infer<typeof acceptedDecisionSchema>
type AcceptedMessage = z.infer<typeof acceptedMessageSchema>
type ChatContentPart = z.infer<typeof contentPartSchema>
type ChatMediaPart = Exclude<ChatContentPart, { type: 'text' }>
type ChatCommand = z.infer<typeof commandSchema>
type ChatContextUsage = z.infer<typeof contextUsageSchema>
type ChatConversation = z.infer<typeof conversationSchema>
type ChatEvent = z.infer<typeof chatEventSchema>
type ChatHistory = z.infer<typeof chatHistorySchema>
type ChatHistoryEntry = z.infer<typeof historyEntrySchema>
type ChatPermissionRequest = z.infer<typeof permissionRequestSchema>
type ChatUsage = z.infer<typeof usageSchema>
type PermissionOutcome = Extract<ChatEvent, { type: 'permissionResolved' }>['outcome']

export {
  acceptedCommandSchema,
  acceptedDecisionSchema,
  acceptedMessageSchema,
  artifactRefSchema,
  chatEventSchema,
  chatHistorySchema,
  commandsSchema,
  contextUsageSchema,
  conversationsSchema,
  permissionRequestSchema,
}

export type {
  AcceptedCommand,
  AcceptedDecision,
  AcceptedMessage,
  ArtifactRef,
  ChatCommand,
  ChatContentPart,
  ChatContextUsage,
  ChatConversation,
  ChatEvent,
  ChatHistory,
  ChatHistoryEntry,
  ChatMediaPart,
  ChatPermissionRequest,
  ChatUsage,
  PermissionOutcome,
}
