import { ApiContractError, requestJson, requestStream } from '@/shared/api/http'

import {
  type AcceptedCommand,
  acceptedCommandSchema,
  acceptedDecisionSchema,
  type AcceptedMessage,
  acceptedMessageSchema,
  type AgentCatalog,
  agentCatalogSchema,
  type ChatCommand,
  type ChatContentPart,
  type ChatConversation,
  type ChatEvent,
  type ChatHistory,
  chatHistorySchema,
  commandsSchema,
  conversationsSchema,
} from './chat.schemas'
import { parseChatEventStream } from './sse'

type PermissionDecision =
  | { readonly decision: 'approve'; readonly scope: 'once' | 'session' }
  | { readonly decision: 'deny' }

interface ChatStreamOptions {
  readonly accessToken: string
  readonly lastEventId?: string
  readonly listener: (event: ChatEvent, eventId?: string) => void
  readonly opened: (streamInstanceId?: string) => void
  readonly signal: AbortSignal
}

interface ConversationInput {
  readonly accessToken: string
  readonly conversationId: string
}

interface ReadHistoryInput extends ConversationInput {
  readonly limit?: number
}

interface SendMessageInput extends ConversationInput {
  readonly agentId?: string
  readonly content: readonly ChatContentPart[]
  readonly messageId: string
}

interface SubmitCommandInput extends ConversationInput {
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly command: string
}

interface SubmitDecisionInput extends ConversationInput {
  readonly accessToken: string
  readonly conversationId: string
  readonly decision: PermissionDecision
  readonly requestId: string
}

interface ChatApi {
  listAgents(accessToken: string): Promise<AgentCatalog>
  listCommands(accessToken: string): Promise<readonly ChatCommand[]>
  listConversations(accessToken: string): Promise<readonly ChatConversation[]>
  openStream(options: ChatStreamOptions): Promise<void>
  readHistory(input: ReadHistoryInput): Promise<ChatHistory>
  sendMessage(input: SendMessageInput): Promise<AcceptedMessage>
  sendSteer(input: SendMessageInput): Promise<AcceptedMessage>
  submitCommand(input: SubmitCommandInput): Promise<AcceptedCommand>
  submitDecision(input: SubmitDecisionInput): Promise<void>
}

function authorization(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}` }
}

function postJson(accessToken: string, value: unknown): RequestInit {
  return {
    body: JSON.stringify(value),
    headers: authorization(accessToken),
    method: 'POST',
  }
}

const chatApi: ChatApi = {
  listAgents(accessToken) {
    return requestJson('/chat/agents', agentCatalogSchema, {
      headers: authorization(accessToken),
    })
  },

  async listCommands(accessToken) {
    const response = await requestJson('/chat/commands', commandsSchema, {
      headers: authorization(accessToken),
    })
    return response.commands
  },

  async listConversations(accessToken) {
    const response = await requestJson('/chat/conversations', conversationsSchema, {
      headers: authorization(accessToken),
    })
    return response.conversations
  },

  async openStream({ accessToken, lastEventId, listener, opened, signal }) {
    const headers = new Headers(authorization(accessToken))
    if (lastEventId !== undefined) headers.set('last-event-id', lastEventId)
    const response = await requestStream('/chat/stream', {
      headers,
      signal,
    })
    if (response.body === null) {
      throw new ApiContractError('Nox opened a chat stream without a response body.')
    }
    opened(response.headers.get('x-nox-chat-stream-id') ?? undefined)
    await parseChatEventStream(response.body, listener)
  },

  readHistory({ accessToken, conversationId, limit }) {
    const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/history${query}`
    return requestJson(path, chatHistorySchema, { headers: authorization(accessToken) })
  },

  sendMessage({ accessToken, agentId, content, conversationId, messageId }) {
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/messages`
    return requestJson(
      path,
      acceptedMessageSchema,
      postJson(accessToken, { agentId, content, messageId }),
    )
  },

  sendSteer({ accessToken, agentId, content, conversationId, messageId }) {
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/steer`
    return requestJson(
      path,
      acceptedMessageSchema,
      postJson(accessToken, { agentId, content, messageId }),
    )
  },

  submitCommand({ accessToken, arguments: commandArguments, command, conversationId }) {
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/commands/${encodeURIComponent(command)}`
    return requestJson(path, acceptedCommandSchema, postJson(accessToken, commandArguments))
  },

  async submitDecision({ accessToken, conversationId, decision, requestId }) {
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/permissions/${encodeURIComponent(requestId)}`
    await requestJson(path, acceptedDecisionSchema, postJson(accessToken, decision))
  },
}

export { chatApi }

export type {
  ChatApi,
  ChatStreamOptions,
  ConversationInput,
  PermissionDecision,
  ReadHistoryInput,
  SendMessageInput,
  SubmitCommandInput,
  SubmitDecisionInput,
}
