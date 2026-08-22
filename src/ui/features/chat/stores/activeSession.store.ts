import { defineStore } from 'pinia'
import { computed, onScopeDispose, readonly, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'

import { chatApi, type PermissionDecision } from '../api/chat.api'

import type {
  ChatEvent,
  ChatPermissionRequest,
  ChatUsage,
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
  | { readonly message: string; readonly turnId?: string; readonly type: 'failed' }
  | { readonly requestId: string; readonly turnId: string; readonly type: 'waiting-permission' }
  | { readonly turnId?: string; readonly type: 'running' }
  | { readonly type: 'idle' }

type PermissionState =
  | { readonly decision: PermissionDecision; readonly type: 'submitting' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly outcome: PermissionOutcome; readonly type: 'resolved' }
  | { readonly type: 'pending' }

type RunCompletionStatus = Extract<ChatEvent, { type: 'runCompleted' }>['status']
type RunTrigger = Extract<ChatEvent, { type: 'runStarted' }>['trigger']
type ToolResponseExecution = Extract<ChatEvent, { type: 'toolResponse' }>['execution']

interface AssistantItem {
  readonly createdAt: string
  readonly id: string
  readonly kind: 'assistant'
  streaming: boolean
  text: string
  readonly turnId: string
}

interface ContextChangeActivity {
  readonly change: 'compacted' | 'folded'
  readonly id: string
  readonly replacedMessageIds: string[]
  readonly text: string
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

interface ReasoningActivity {
  readonly id: string
  readonly kind: 'reasoning'
  streaming: boolean
  text: string
  readonly turnId: string
}

interface RetryActivity {
  readonly attempt: number
  readonly delayMs: number
  readonly id: string
  readonly text: string
}

interface ToolResponseActivity {
  readonly execution: ToolResponseExecution
  readonly id: string
  readonly isError: boolean
  readonly text: string
}

interface ToolActivity {
  arguments?: Record<string, unknown>
  readonly id: string
  readonly kind: 'tool'
  name: string
  readonly responses: ToolResponseActivity[]
  readonly trackId: string
  readonly turnId: string
}

interface RunActivityItem {
  readonly contextChanges: ContextChangeActivity[]
  durationMs?: number
  readonly id: string
  readonly kind: 'activity'
  modelId?: string
  readonly reasoning: ReasoningActivity[]
  readonly retries: RetryActivity[]
  startedAt?: string
  status?: RunCompletionStatus
  readonly tools: ToolActivity[]
  trigger?: RunTrigger
  readonly turnId: string
  readonly usageCalls: ChatUsage[]
  usageTotal?: ChatUsage
}

interface UserItem {
  readonly createdAt: string
  readonly id: string
  readonly kind: 'user'
  readonly text: string
}

type TimelineItem =
  | AssistantItem
  | ErrorItem
  | PermissionItem
  | ReasoningActivity
  | RunActivityItem
  | ToolActivity
  | UserItem

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
    const item: UserItem = {
      createdAt: new Date().toISOString(),
      id: messageId,
      kind: 'user',
      text: normalized,
    }
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
      if (isSending(messageId)) run.value = { type: 'running' }
      return true
    } catch (error) {
      items.value = items.value.filter((candidate) => candidate !== item)
      if (isSending(messageId)) run.value = { type: 'idle' }
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
      case 'contextChange':
        activityItem(event.turnId).contextChanges.push({
          change: event.change,
          id: createId('context'),
          replacedMessageIds: event.replacedMessageIds,
          text: event.text,
        })
        break
      case 'error':
        insertBeforeRunSummary(event.turnId, {
          id: createId('error'),
          kind: 'error',
          text: event.text,
          turnId: event.turnId,
        })
        run.value = { message: event.text, turnId: event.turnId, type: 'failed' }
        break
      case 'fragment':
        appendFragment(event.turnId, event.text)
        markRunning(event.turnId)
        break
      case 'message':
        settleMessage(event.turnId, event.text)
        break
      case 'permission':
        if (permissionItem(event.request.requestId) === undefined) {
          insertBeforeRunSummary(event.turnId, {
            id: `permission_${event.request.requestId}`,
            kind: 'permission',
            request: event.request,
            state: { type: 'pending' },
            turnId: event.turnId,
          })
        }
        if (
          run.value.type !== 'running' ||
          run.value.turnId === undefined ||
          run.value.turnId === event.turnId
        ) {
          run.value = {
            requestId: event.request.requestId,
            turnId: event.turnId,
            type: 'waiting-permission',
          }
        }
        break
      case 'permissionResolved': {
        const item = permissionItem(event.requestId)
        if (item !== undefined) item.state = { outcome: event.outcome, type: 'resolved' }
        if (run.value.type === 'waiting-permission' && run.value.requestId === event.requestId) {
          run.value =
            event.outcome.resolution === 'aborted'
              ? { type: 'idle' }
              : { turnId: event.turnId, type: 'running' }
        }
        break
      }
      case 'reasoning':
        settleReasoning(event.turnId, event.text)
        break
      case 'reasoningFragment':
        appendReasoningFragment(event.turnId, event.text)
        markRunning(event.turnId)
        break
      case 'retry':
        discardStreamingDrafts(event.turnId)
        activityItem(event.turnId).retries.push({
          attempt: event.attempt,
          delayMs: event.delayMs,
          id: createId('retry'),
          text: event.text,
        })
        markRunning(event.turnId)
        break
      case 'runCompleted': {
        const activity = activityItem(event.turnId)
        activity.durationMs = event.durationMs
        activity.status = event.status
        if (event.usage !== undefined) activity.usageTotal = event.usage

        if (isCurrentRun(event.turnId)) {
          if (event.status === 'failed') {
            if (run.value.type !== 'failed') {
              run.value = {
                message: 'The run ended before Nox could complete it.',
                turnId: event.turnId,
                type: 'failed',
              }
            }
          } else {
            run.value = { type: 'idle' }
          }
        }
        break
      }
      case 'runStarted': {
        const activity = activityItem(event.turnId)
        activity.modelId = event.modelId
        activity.startedAt = event.startedAt
        activity.trigger = event.trigger
        run.value = { turnId: event.turnId, type: 'running' }
        sendError.value = undefined
        break
      }
      case 'toolCall': {
        const activity = activityItem(event.turnId)
        const tool = toolActivity(activity, event.trackId, event.name)
        tool.arguments = event.arguments
        tool.name = event.name
        break
      }
      case 'toolResponse': {
        const tool = toolActivity(activityItem(event.turnId), event.trackId, event.name)
        tool.name = event.name
        tool.responses.push({
          execution: event.execution,
          id: createId('response'),
          isError: event.isError,
          text: event.text,
        })
        break
      }
      case 'usage':
        activityItem(event.turnId).usageCalls.push(event.usage)
        break
    }
  }

  function activityItem(turnId: string): RunActivityItem {
    const existing = items.value.find(
      (item): item is RunActivityItem => item.kind === 'activity' && item.turnId === turnId,
    )
    if (existing !== undefined) return existing

    const activity: RunActivityItem = {
      contextChanges: [],
      id: `activity_${turnId}`,
      kind: 'activity',
      reasoning: [],
      retries: [],
      tools: [],
      turnId,
      usageCalls: [],
    }
    items.value.push(activity)
    return activity
  }

  function appendFragment(turnId: string, text: string): void {
    const existing = streamingAssistantItem(turnId)
    if (existing !== undefined) {
      existing.text += text
      return
    }

    insertBeforeRunSummary(turnId, {
      createdAt: new Date().toISOString(),
      id: createId('assistant'),
      kind: 'assistant',
      streaming: true,
      text,
      turnId,
    })
  }

  function settleMessage(turnId: string, text: string): void {
    const existing = streamingAssistantItem(turnId)
    if (existing !== undefined) {
      existing.text = text
      existing.streaming = false
      return
    }

    insertBeforeRunSummary(turnId, {
      createdAt: new Date().toISOString(),
      id: createId('assistant'),
      kind: 'assistant',
      streaming: false,
      text,
      turnId,
    })
  }

  function appendReasoningFragment(turnId: string, text: string): void {
    const activity = activityItem(turnId)
    const current = activity.reasoning[activity.reasoning.length - 1]
    if (current?.streaming === true) {
      current.text += text
      return
    }
    const reasoning: ReasoningActivity = {
      id: createId('reasoning'),
      kind: 'reasoning',
      streaming: true,
      text,
      turnId,
    }
    activity.reasoning.push(reasoning)
    insertBeforeRunSummary(turnId, reasoning)
  }

  function settleReasoning(turnId: string, text: string): void {
    const activity = activityItem(turnId)
    const current = activity.reasoning[activity.reasoning.length - 1]
    if (current?.streaming === true) {
      current.text = text
      current.streaming = false
      return
    }
    const reasoning: ReasoningActivity = {
      id: createId('reasoning'),
      kind: 'reasoning',
      streaming: false,
      text,
      turnId,
    }
    activity.reasoning.push(reasoning)
    insertBeforeRunSummary(turnId, reasoning)
  }

  function discardStreamingDrafts(turnId: string): void {
    items.value = items.value.filter(
      (item) => !(item.kind === 'assistant' && item.turnId === turnId && item.streaming),
    )
    const reasoning = items.value.find(
      (item): item is RunActivityItem => item.kind === 'activity' && item.turnId === turnId,
    )?.reasoning
    const latestReasoning = reasoning?.[reasoning.length - 1]
    if (latestReasoning?.streaming === true) latestReasoning.text = ''
  }

  function streamingAssistantItem(turnId: string): AssistantItem | undefined {
    for (let index = items.value.length - 1; index >= 0; index -= 1) {
      const item = items.value[index]
      if (item?.kind === 'assistant' && item.turnId === turnId && item.streaming) return item
    }
    return undefined
  }

  function permissionItem(requestId: string): PermissionItem | undefined {
    return items.value.find(
      (item): item is PermissionItem =>
        item.kind === 'permission' && item.request.requestId === requestId,
    )
  }

  function toolActivity(activity: RunActivityItem, trackId: string, name: string): ToolActivity {
    const existing = activity.tools.find((tool) => tool.trackId === trackId)
    if (existing !== undefined) return existing

    const tool: ToolActivity = {
      id: `tool_${trackId}`,
      kind: 'tool',
      name,
      responses: [],
      trackId,
      turnId: activity.turnId,
    }
    activity.tools.push(tool)
    insertBeforeRunSummary(activity.turnId, tool)
    return tool
  }

  function insertBeforeRunSummary(turnId: string, item: TimelineItem): void {
    const summaryIndex = items.value.findIndex(
      (candidate) => candidate.kind === 'activity' && candidate.turnId === turnId,
    )
    if (summaryIndex === -1) {
      items.value.push(item)
      return
    }
    items.value.splice(summaryIndex, 0, item)
  }

  function markRunning(turnId: string): void {
    if (run.value.type !== 'running' || run.value.turnId === undefined) {
      run.value = { turnId, type: 'running' }
    }
  }

  function isSending(messageId: string): boolean {
    return run.value.type === 'sending' && run.value.clientMessageId === messageId
  }

  function isCurrentRun(turnId: string): boolean {
    if (run.value.type === 'running') return run.value.turnId === undefined || run.value.turnId === turnId
    if (run.value.type === 'waiting-permission' || run.value.type === 'failed') {
      return run.value.turnId === undefined || run.value.turnId === turnId
    }
    return true
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
    return 'The internal chat transport is temporarily unavailable.'
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
  ContextChangeActivity,
  ErrorItem,
  PermissionItem,
  PermissionState,
  ReasoningActivity,
  RetryActivity,
  RunActivityItem,
  TimelineItem,
  ToolActivity,
  ToolResponseActivity,
  UserItem,
}
