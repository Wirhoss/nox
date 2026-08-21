import { ApiContractError, requestJson, requestStream } from '@/shared/api/http'

import {
  acceptedDecisionSchema,
  type AcceptedMessage,
  acceptedMessageSchema,
  type ChatEvent,
} from './chat.schemas'
import { parseChatEventStream } from './sse'

type PermissionDecision =
  | { readonly decision: 'approve'; readonly scope: 'once' | 'session' }
  | { readonly decision: 'deny' }

interface ChatStreamOptions {
  readonly accessToken: string
  readonly listener: (event: ChatEvent) => void
  readonly opened: () => void
  readonly signal: AbortSignal
}

interface SendMessageInput {
  readonly accessToken: string
  readonly conversationId: string
  readonly messageId: string
  readonly text: string
}

interface SubmitDecisionInput {
  readonly accessToken: string
  readonly conversationId: string
  readonly decision: PermissionDecision
  readonly requestId: string
}

interface ChatApi {
  openStream(options: ChatStreamOptions): Promise<void>
  sendMessage(input: SendMessageInput): Promise<AcceptedMessage>
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
  async openStream({ accessToken, listener, opened, signal }) {
    const response = await requestStream('/chat/stream', {
      headers: authorization(accessToken),
      signal,
    })
    if (response.body === null) {
      throw new ApiContractError('Nox opened a chat stream without a response body.')
    }
    opened()
    await parseChatEventStream(response.body, listener)
  },

  sendMessage({ accessToken, conversationId, messageId, text }) {
    const path = `/chat/conversations/${encodeURIComponent(conversationId)}/messages`
    return requestJson(path, acceptedMessageSchema, postJson(accessToken, { messageId, text }))
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
  PermissionDecision,
  SendMessageInput,
  SubmitDecisionInput,
}
