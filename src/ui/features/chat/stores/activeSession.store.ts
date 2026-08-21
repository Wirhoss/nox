import { defineStore } from 'pinia'
import { computed, onScopeDispose, readonly, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'

import { chatApi, type PermissionDecision } from '../api/chat.api'

import type {
  ChatEvent,
  ChatPermissionRequest,
  PermissionOutcome,
} from '../api/chat.schemas'

type ChatConnection =
  | { readonly attempt: number; readonly type: 'reconnecting' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'connected' }
  | { readonly type: 'connecting' }
  | { readonly type: 'disconnected' }
  | { readonly type: 'unavailable' }

type ChatRunStatus =
  | { readonly clientMessageId: string; readonly type: 'sending' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly requestId: string; readonly type: 'waiting-permission' }
  | { readonly type: 'idle' }
  | { readonly type: 'running' }

type PermissionState =
  | { readonly decision: PermissionDecision; readonly type: 'submitting' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly outcome: PermissionOutcome; readonly type: 'resolved' }
  | { readonly type: 'pending' }

interface AssistantItem {
  readonly id: string
  readonly kind: 'assistant'
  streaming: boolean
  text: string
  readonly turnId: string
}

interface ErrorItem {
  readonly id: string
  readonly kind: 'error'
  readonly text: string
  readonly turnId: string
}

interface PermissionItem {
  readonly id: string
  readonly kind: 'permission'
  readonly request: ChatPermissionRequest
  state: PermissionState
  readonly turnId: string
}

interface UserItem {
  readonly id: string
  readonly kind: 'user'
  readonly text: string
}

type TimelineItem = AssistantItem | ErrorItem | PermissionItem | UserItem

const useActiveSessionStore = defineStore('active-session', () => {
  const auth = useAuthStore()
  const connection = ref<ChatConnection>({ type: 'disconnected' })
  const conversationId = ref(createId('web'))
  const items = ref<TimelineItem[]>([])
  const run = ref<ChatRunStatus>({ type: 'idle' })
  const sendError = ref<string>()

  const canSend = computed(
    () =>
      connection.value.type === 'connected' &&
      (run.value.type === 'failed' || run.value.type === 'idle'),
  )
  const pendingPermissionCount = computed(
    () =>
      items.value.filter(
        (item) => item.kind === 'permission' && item.state.type !== 'resolved',
      ).length,
  )

  let streamController: AbortController | undefined

  function connect(): void {
    if (streamController !== undefined) return
    const accessToken = auth.accessToken
    if (accessToken === undefined) {
      connection.value = { message: 'No authenticated session is available.', type: 'failed' }
      return
    }

    const controller = new AbortController()
    streamController = controller
    connection.value = { type: 'connecting' }
    void consumeStream(controller)
  }

  function disconnect(): void {
    streamController?.abort()
    streamController = undefined
    connection.value = { type: 'disconnected' }
  }

  function reconnect(): void {
    disconnect()
    connect()
  }

  async function consumeStream(controller: AbortController): Promise<void> {
    let attempt = 0

    while (!isAborted(controller.signal)) {
      const accessToken = auth.accessToken
      if (accessToken === undefined) {
        connection.value = { message: 'No authenticated session is available.', type: 'failed' }
        break
      }

      try {
        await chatApi.openStream({
          accessToken,
          listener: applyEvent,
          opened: () => {
            if (
              connection.value.type === 'reconnecting' &&
              (run.value.type === 'running' || run.value.type === 'sending')
            ) {
              run.value = { type: 'idle' }
              sendError.value =
                'The live stream reconnected. Output from the interrupted run may be incomplete.'
            }
            attempt = 0
            connection.value = { type: 'connected' }
          },
          signal: controller.signal,
        })
        attempt += 1
        connection.value = { attempt, type: 'reconnecting' }
        await waitForRetry(Math.min(4_000, attempt * 1_000), controller.signal)
      } catch (error) {
        if (isAborted(controller.signal)) break
        if (error instanceof ApiError && error.code === 'chat_unavailable') {
          connection.value = { type: 'unavailable' }
          break
        }
        if (error instanceof ApiError && error.status === 401) {
          connection.value = { message: 'The chat session is no longer authorized.', type: 'failed' }
          auth.requireLogin()
          break
        }
        if (error instanceof ApiContractError) {
          connection.value = { message: 'Nox sent an invalid chat event.', type: 'failed' }
          break
        }

        attempt += 1
        connection.value = { attempt, type: 'reconnecting' }
        await waitForRetry(Math.min(4_000, attempt * 1_000), controller.signal)
      }
    }

    if (streamController === controller) streamController = undefined
  }

  async function send(text: string): Promise<boolean> {
    const normalized = text.trim()
    const accessToken = auth.accessToken
    if (normalized.length === 0 || accessToken === undefined || !canSend.value) return false

    const messageId = createId('msg')
    const item: UserItem = { id: messageId, kind: 'user', text: normalized }
    items.value.push(item)
    run.value = { clientMessageId: messageId, type: 'sending' }
    sendError.value = undefined

    try {
      await chatApi.sendMessage({
        accessToken,
        conversationId: conversationId.value,
        messageId,
        text: normalized,
      })
      run.value = { type: 'running' }
      return true
    } catch (error) {
      items.value = items.value.filter((candidate) => candidate !== item)
      run.value = { type: 'idle' }
      sendError.value = messageFor(error)
      if (error instanceof ApiError && error.code === 'chat_unavailable') {
        connection.value = { type: 'unavailable' }
      }
      if (error instanceof ApiError && error.status === 401) auth.requireLogin()
      return false
    }
  }

  async function decide(requestId: string, decision: PermissionDecision): Promise<void> {
    const accessToken = auth.accessToken
    const item = permissionItem(requestId)
    if (accessToken === undefined || item === undefined || item.state.type === 'resolved') return

    item.state = { decision, type: 'submitting' }
    try {
      await chatApi.submitDecision({
        accessToken,
        conversationId: conversationId.value,
        decision,
        requestId,
      })
    } catch (error) {
      item.state = { message: messageFor(error), type: 'failed' }
      if (error instanceof ApiError && error.status === 401) auth.requireLogin()
    }
  }

  function applyEvent(event: ChatEvent): void {
    if (event.conversationId !== conversationId.value) return

    switch (event.type) {
      case 'error':
        items.value.push({
          id: createId('error'),
          kind: 'error',
          text: event.text,
          turnId: event.turnId,
        })
        run.value = { message: event.text, type: 'failed' }
        break
      case 'fragment':
        appendFragment(event.turnId, event.text)
        run.value = { type: 'running' }
        break
      case 'message':
        settleMessage(event.turnId, event.text)
        run.value = { type: 'idle' }
        break
      case 'permission':
        if (permissionItem(event.request.requestId) === undefined) {
          items.value.push({
            id: `permission_${event.request.requestId}`,
            kind: 'permission',
            request: event.request,
            state: { type: 'pending' },
            turnId: event.turnId,
          })
        }
        run.value = { requestId: event.request.requestId, type: 'waiting-permission' }
        break
      case 'permissionResolved': {
        const item = permissionItem(event.requestId)
        if (item !== undefined) item.state = { outcome: event.outcome, type: 'resolved' }
        run.value = event.outcome.resolution === 'aborted' ? { type: 'idle' } : { type: 'running' }
        break
      }
    }
  }

  function appendFragment(turnId: string, text: string): void {
    const existing = assistantItem(turnId)
    if (existing !== undefined) {
      existing.text += text
      return
    }

    items.value.push({
      id: `assistant_${turnId}`,
      kind: 'assistant',
      streaming: true,
      text,
      turnId,
    })
  }

  function settleMessage(turnId: string, text: string): void {
    const existing = assistantItem(turnId)
    if (existing !== undefined) {
      existing.text = text
      existing.streaming = false
      return
    }

    items.value.push({
      id: `assistant_${turnId}`,
      kind: 'assistant',
      streaming: false,
      text,
      turnId,
    })
  }

  function assistantItem(turnId: string): AssistantItem | undefined {
    const item = items.value.find(
      (candidate): candidate is AssistantItem =>
        candidate.kind === 'assistant' && candidate.turnId === turnId,
    )
    return item
  }

  function permissionItem(requestId: string): PermissionItem | undefined {
    const item = items.value.find(
      (candidate): candidate is PermissionItem =>
        candidate.kind === 'permission' && candidate.request.requestId === requestId,
    )
    return item
  }

  onScopeDispose(disconnect)

  return {
    applyEvent,
    canSend,
    connect,
    connection: readonly(connection),
    conversationId: readonly(conversationId),
    decide,
    disconnect,
    items: readonly(items),
    pendingPermissionCount,
    reconnect,
    run: readonly(run),
    send,
    sendError: readonly(sendError),
  }
})

function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${value}`
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === 'chat_unavailable') {
    return 'No web broker is configured for this Nox node.'
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session is no longer authorized.'
  }
  if (error instanceof ApiConnectionError) {
    return 'The Nox node did not answer.'
  }
  return 'The message could not be handed to Nox.'
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export { useActiveSessionStore }

export type {
  AssistantItem,
  ChatConnection,
  ChatRunStatus,
  ErrorItem,
  PermissionItem,
  PermissionState,
  TimelineItem,
  UserItem,
}
