import { WEB_BROKER_ID } from '@nox/extension-api'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, readonly, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'
import { useI18n } from '@/shared/i18n'

import { chatApi } from '../api/chat.api'
import { createId, createTimeline, mediaFrom } from '../model/timeline'

import type { PermissionDecision } from '../api/chat.api'
import type {
  ChatCommand,
  ChatContentPart,
  ChatContextUsage,
  ChatConversation,
  ChatEvent,
  ChatHistory,
  ChatHistoryEntry,
} from '../api/chat.schemas'
import type { AssistantItem, ContextChangeActivity, ErrorItem, PermissionItem, PermissionState, ReasoningActivity, RetryActivity, RunActivityItem, TimelineItem, ToolActivity, ToolResponseActivity, UserItem } from '../model/timeline'

type ChatConnection =
  | { readonly attempt: number; readonly type: 'reconnecting' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'connected' }
  | { readonly type: 'connecting' }
  | { readonly type: 'disconnected' }
  | { readonly type: 'unavailable' }

type ChatRunStatus =
  | {
      readonly clientMessageId: string
      readonly mode: 'message' | 'steer'
      readonly type: 'sending'
    }
  | { readonly message: string; readonly turnId?: string; readonly type: 'failed' }
  | { readonly requestId: string; readonly turnId: string; readonly type: 'waiting-permission' }
  | { readonly turnId?: string; readonly type: 'running' }
  | { readonly type: 'idle' }

type ChatResourceState =
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'loading' }
  | { readonly type: 'ready' }

const useActiveSessionStore = defineStore('active-session', () => {
  const auth = useAuthStore()
  const { t } = useI18n()
  const agentIds = ref<readonly string[]>([])
  const catalog = ref<ChatResourceState>({ type: 'loading' })
  const commands = ref<readonly ChatCommand[]>([])
  const connection = ref<ChatConnection>({ type: 'disconnected' })
  const contextUsage = ref<ChatContextUsage>()
  const conversationId = ref(createId(WEB_BROKER_ID))
  const conversations = ref<readonly ChatConversation[]>([])
  const defaultAgentId = ref<string>()
  const history = ref<ChatResourceState>({ type: 'ready' })
  const items = ref<TimelineItem[]>([])
  const timeline = createTimeline(items)
  const activityItem = timeline.activityItem.bind(undefined)
  const appendFragment = timeline.appendFragment.bind(undefined)
  const appendReasoningFragment = timeline.appendReasoningFragment.bind(undefined)
  const discardStreamingDrafts = timeline.discardStreamingDrafts.bind(undefined)
  const insertBeforeRunSummary = timeline.insertBeforeRunSummary.bind(undefined)
  const permissionItem = timeline.permissionItem.bind(undefined)
  const projectHistory = timeline.projectHistory.bind(undefined)
  const settleMessage = timeline.settleMessage.bind(undefined)
  const settleReasoning = timeline.settleReasoning.bind(undefined)
  const toolActivity = timeline.toolActivity.bind(undefined)
  const run = ref<ChatRunStatus>({ type: 'idle' })
  const selectedAgentId = ref<string>()
  const sendError = ref<string>()

  const activeConversation = computed(() =>
    conversations.value.find(
      (conversation) => conversation.conversationId === conversationId.value,
    ),
  )
  const canSend = computed(
    () =>
      connection.value.type === 'connected' &&
      selectedAgentId.value !== undefined &&
      run.value.type !== 'sending',
  )
  const sendMode = computed<'message' | 'steer'>(() =>
    run.value.type === 'running' || run.value.type === 'waiting-permission' ? 'steer' : 'message',
  )
  const pendingPermissionCount = computed(
    () =>
      items.value.filter((item) => item.kind === 'permission' && item.state.type !== 'resolved')
        .length,
  )

  /**
   * Names that arrived on the stream. Kept so a list fetched around the same
   * moment cannot drop one: the request that answers with the conversations may
   * well have left before the session was named.
   */
  const liveTitles = new Map<string, string>()

  let eventBuffer: ChatEvent[] | undefined
  let initializePromise: Promise<void> | undefined
  let lastEventId: string | undefined
  let selectionVersion = 0
  let streamController: AbortController | undefined
  let streamInstanceId: string | undefined

  function initialize(): Promise<void> {
    initializePromise ??= initializeChat()
    return initializePromise
  }

  async function initializeChat(): Promise<void> {
    eventBuffer = []
    connect()

    const accessToken = auth.accessToken
    if (accessToken === undefined) {
      catalog.value = { message: t('chat.error.noAuthenticatedSession'), type: 'failed' }
      eventBuffer = undefined
      return
    }

    catalog.value = { type: 'loading' }
    try {
      const [availableAgents, availableCommands, availableConversations] = await Promise.all([
        chatApi.listAgents(accessToken),
        chatApi.listCommands(accessToken),
        chatApi.listConversations(accessToken),
      ])
      agentIds.value = availableAgents.agents
      defaultAgentId.value = availableAgents.defaultAgent
      selectedAgentId.value =
        defaultAgentId.value ??
        (availableAgents.agents.length === 1 ? availableAgents.agents[0] : undefined)
      commands.value = availableCommands
      conversations.value = withLiveTitles(availableConversations)
      catalog.value = { type: 'ready' }

      const latest = availableConversations[0]
      if (latest === undefined) {
        const buffer = eventBuffer
        eventBuffer = undefined
        replayBufferedEvents(buffer)
        return
      }
      await openConversation(latest.conversationId)
    } catch (error) {
      eventBuffer = undefined
      catalog.value = {
        message: resourceMessageFor(error, t('chat.action.loadConversations'), t),
        type: 'failed',
      }
      handleAuthorizationError(error)
    }
  }

  function withLiveTitles(listed: readonly ChatConversation[]): readonly ChatConversation[] {
    if (liveTitles.size === 0) return listed
    return listed.map((conversation) => {
      const title = liveTitles.get(conversation.conversationId)
      return title === undefined ? conversation : { ...conversation, title }
    })
  }

  function renameConversation(namedConversationId: string, title: string): void {
    liveTitles.set(namedConversationId, title)
    conversations.value = withLiveTitles(conversations.value)
  }

  async function refreshConversations(): Promise<void> {
    const accessToken = auth.accessToken
    if (accessToken === undefined) return

    try {
      conversations.value = withLiveTitles(await chatApi.listConversations(accessToken))
    } catch (error) {
      catalog.value = {
        message: resourceMessageFor(error, t('chat.action.refreshConversations'), t),
        type: 'failed',
      }
      handleAuthorizationError(error)
    }
  }

  function handleAuthorizationError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) auth.requireLogin()
  }

  function newConversation(): void {
    selectionVersion += 1
    eventBuffer = undefined
    conversationId.value = createId(WEB_BROKER_ID)
    selectedAgentId.value =
      defaultAgentId.value ?? (agentIds.value.length === 1 ? agentIds.value[0] : undefined)
    contextUsage.value = undefined
    history.value = { type: 'ready' }
    items.value = []
    run.value = { type: 'idle' }
    sendError.value = undefined
  }

  async function openConversation(nextConversationId: string): Promise<void> {
    if (nextConversationId === conversationId.value && items.value.length > 0) return

    const accessToken = auth.accessToken
    if (accessToken === undefined) return

    const version = ++selectionVersion
    const buffer = eventBuffer ?? []
    eventBuffer = buffer
    conversationId.value = nextConversationId
    const selectedConversation = conversations.value.find(
      (conversation) => conversation.conversationId === nextConversationId,
    )
    selectedAgentId.value = selectedConversation?.agentId
    contextUsage.value = selectedConversation?.contextUsage
    history.value = { type: 'loading' }
    items.value = []
    run.value = { type: 'idle' }
    sendError.value = undefined

    let loaded: ChatHistory | undefined
    try {
      loaded = await chatApi.readHistory({
        accessToken,
        conversationId: nextConversationId,
        limit: 1_000,
      })
      if (version !== selectionVersion) return
      projectHistory(loaded)
      contextUsage.value = loaded.contextUsage ?? contextUsage.value
      history.value = { type: 'ready' }
    } catch (error) {
      if (version !== selectionVersion) return
      history.value = {
        message: resourceMessageFor(error, t('chat.action.loadConversation'), t),
        type: 'failed',
      }
      handleAuthorizationError(error)
    }

    if (eventBuffer === buffer) eventBuffer = undefined
    if (version !== selectionVersion) return
    replayBufferedEvents(buffer, loaded)
  }

  function selectAgent(agentId: string): void {
    if (activeConversation.value !== undefined || !agentIds.value.includes(agentId)) return
    selectedAgentId.value = agentId
    sendError.value = undefined
  }

  function connect(): void {
    if (streamController !== undefined) return
    const accessToken = auth.accessToken
    if (accessToken === undefined) {
      connection.value = { message: t('chat.error.noAuthenticatedSession'), type: 'failed' }
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
    initializePromise = undefined
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
        connection.value = { message: t('chat.error.noAuthenticatedSession'), type: 'failed' }
        break
      }

      try {
        await chatApi.openStream({
          accessToken,
          lastEventId,
          listener: (event, eventId) => {
            if (eventId !== undefined) lastEventId = eventId.length === 0 ? undefined : eventId
            applyEvent(event)
          },
          opened: (nextStreamInstanceId) => {
            const backendRestarted =
              streamInstanceId !== undefined &&
              nextStreamInstanceId !== undefined &&
              streamInstanceId !== nextStreamInstanceId
            streamInstanceId = nextStreamInstanceId ?? streamInstanceId
            if (
              backendRestarted &&
              (run.value.type === 'running' || run.value.type === 'sending')
            ) {
              run.value = { type: 'idle' }
              sendError.value = t('chat.error.reconnectedIncomplete')
              lastEventId = undefined
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
        if (error instanceof ApiError && error.status === 401) {
          connection.value = {
            message: t('chat.error.noLongerAuthorized'),
            type: 'failed',
          }
          auth.requireLogin()
          break
        }
        if (error instanceof ApiContractError) {
          connection.value = { message: t('chat.error.invalidEvent'), type: 'failed' }
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
    return normalized.length === 0 ? false : sendPrepared(normalized)
  }

  async function sendContent(content: readonly ChatContentPart[]): Promise<boolean> {
    const normalized = content.flatMap((part): ChatContentPart[] => {
      if (part.type !== 'text') return [part]
      const text = part.text.trim()
      return text.length === 0 ? [] : [{ text, type: 'text' }]
    })
    if (normalized.length === 0) return false
    const text = normalized
      .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('')
    return sendPrepared(text, normalized)
  }

  async function sendPrepared(
    text: string,
    content?: readonly ChatContentPart[],
  ): Promise<boolean> {
    const accessToken = auth.accessToken
    if (accessToken === undefined || !canSend.value) return false

    const messageId = createId('msg')
    const mode = sendMode.value
    const steeredTurnId =
      mode === 'steer' && (run.value.type === 'running' || run.value.type === 'waiting-permission')
        ? run.value.turnId
        : undefined
    const item: UserItem = {
      createdAt: new Date().toISOString(),
      id: messageId,
      kind: 'user',
      media: mediaFrom(content),
      mode,
      ...(steeredTurnId === undefined ? {} : { steeredTurnId }),
      text,
    }
    items.value.push(item)
    run.value = { clientMessageId: messageId, mode, type: 'sending' }
    sendError.value = undefined

    try {
      const input = {
        accessToken,
        agentId: selectedAgentId.value,
        content: content ?? [{ text, type: 'text' as const }],
        conversationId: conversationId.value,
        messageId,
      }
      if (mode === 'steer') await chatApi.sendSteer(input)
      else await chatApi.sendMessage(input)
      if (isSending(messageId)) {
        run.value =
          steeredTurnId === undefined
            ? { type: 'running' }
            : { turnId: steeredTurnId, type: 'running' }
      }
      void refreshConversations()
      return true
    } catch (error) {
      items.value = items.value.filter((candidate) => candidate !== item)
      if (isSending(messageId)) run.value = { type: 'idle' }
      sendError.value = messageFor(error, t)
      if (error instanceof ApiError && error.code === 'chat_unavailable') {
        connection.value = { type: 'unavailable' }
      }
      if (error instanceof ApiError && error.status === 401) auth.requireLogin()
      return false
    }
  }

  async function invokeCommand(
    command: string,
    commandArguments?: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const accessToken = auth.accessToken
    if (accessToken === undefined || connection.value.type !== 'connected') return false

    sendError.value = undefined
    try {
      await chatApi.submitCommand({
        accessToken,
        arguments: commandArguments,
        command,
        conversationId: conversationId.value,
      })
      return true
    } catch (error) {
      sendError.value = resourceMessageFor(error, t('chat.action.runCommand', { command }), t)
      if (error instanceof ApiError && error.code === 'chat_unavailable') {
        connection.value = { type: 'unavailable' }
      }
      handleAuthorizationError(error)
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
      item.state = { message: messageFor(error, t), type: 'failed' }
      if (error instanceof ApiError && error.status === 401) auth.requireLogin()
    }
  }

  function applyEvent(event: ChatEvent): void {
    if (eventBuffer !== undefined) {
      eventBuffer.push(event)
      return
    }
    // A name belongs to the list of conversations rather than to the transcript
    // on screen, so it is applied whichever conversation it names.
    if (event.type === 'title') {
      renameConversation(event.conversationId, event.title)
      return
    }
    if (event.conversationId !== conversationId.value) return

    switch (event.type) {
      case 'commandResult':
        if (event.status === 'completed') {
          settleMessage(event.turnId, `**/${event.name}**\n\n${event.text}`)
        } else {
          insertBeforeRunSummary(event.turnId, {
            id: createId('error'),
            kind: 'error',
            text: `/${event.name}: ${event.text}`,
            turnId: event.turnId,
          })
        }
        void refreshConversations()
        break
      case 'contextChange':
        activityItem(event.turnId).contextChanges.push({
          change: event.change,
          id: createId('context'),
          replacedMessageIds: event.replacedMessageIds,
          text: event.text,
        })
        break
      case 'contextUsage':
        contextUsage.value = event.usage
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
        settleMessage(event.turnId, event.text, event.content)
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
        activity.historical = false
        activity.durationMs = event.durationMs
        activity.status = event.status
        if (event.usage !== undefined) activity.usageTotal = event.usage

        if (isCurrentRun(event.turnId)) {
          if (event.status === 'failed') {
            if (run.value.type !== 'failed') {
              run.value = {
                message: t('chat.error.runEndedEarly'),
                turnId: event.turnId,
                type: 'failed',
              }
            }
          } else {
            run.value = { type: 'idle' }
          }
        }
        void refreshConversations()
        break
      }
      case 'runStarted': {
        const activity = activityItem(event.turnId)
        activity.historical = false
        activity.modelId = event.modelId
        activity.startedAt = event.startedAt
        activity.trigger = event.trigger
        run.value = { turnId: event.turnId, type: 'running' }
        sendError.value = undefined
        void refreshConversations()
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
          media: mediaFrom(event.content),
          text: event.text,
        })
        break
      }
      case 'usage':
        activityItem(event.turnId).usageCalls.push(event.usage)
        break
    }
  }

  function replayBufferedEvents(buffer: readonly ChatEvent[], loaded?: ChatHistory): void {
    const represented = new Map<string, number>()
    for (const entry of loaded?.entries ?? []) {
      const signature = historyEntrySignature(entry)
      if (signature !== undefined) represented.set(signature, (represented.get(signature) ?? 0) + 1)
    }

    const duplicate = new Set<ChatEvent>()
    const pendingReasoningFragments = new Map<string, ChatEvent[]>()
    const pendingTextFragments = new Map<string, ChatEvent[]>()
    for (const event of buffer) {
      if (event.conversationId !== conversationId.value) continue
      if (event.type === 'fragment') {
        appendPending(pendingTextFragments, event)
        continue
      }
      if (event.type === 'reasoningFragment') {
        appendPending(pendingReasoningFragments, event)
        continue
      }

      const signature = eventSignature(event)
      const count = signature === undefined ? 0 : (represented.get(signature) ?? 0)
      if (signature !== undefined && count > 0) {
        represented.set(signature, count - 1)
        duplicate.add(event)
        if (event.type === 'message') {
          for (const fragment of pendingTextFragments.get(event.turnId) ?? []) {
            duplicate.add(fragment)
          }
        }
        if (event.type === 'reasoning') {
          for (const fragment of pendingReasoningFragments.get(event.turnId) ?? []) {
            duplicate.add(fragment)
          }
        }
      }

      if (event.type === 'message') pendingTextFragments.delete(event.turnId)
      if (event.type === 'reasoning') pendingReasoningFragments.delete(event.turnId)
    }

    for (const event of buffer) {
      if (event.conversationId !== conversationId.value || duplicate.has(event)) continue
      applyEvent(event)
    }
  }

  function markRunning(turnId: string): void {
    if (run.value.type !== 'running' || run.value.turnId === undefined) {
      run.value = { turnId, type: 'running' }
    }
    sendError.value = undefined
  }

  function isSending(messageId: string): boolean {
    return run.value.type === 'sending' && run.value.clientMessageId === messageId
  }

  function isCurrentRun(turnId: string): boolean {
    if (run.value.type === 'running')
      return run.value.turnId === undefined || run.value.turnId === turnId
    if (run.value.type === 'waiting-permission' || run.value.type === 'failed') {
      return run.value.turnId === undefined || run.value.turnId === turnId
    }
    return true
  }

  onScopeDispose(disconnect)

  return {
    activeConversation,
    agentIds: readonly(agentIds),
    applyEvent,
    canSend,
    catalog: readonly(catalog),
    commands: readonly(commands),
    connect,
    connection: readonly(connection),
    contextUsage: readonly(contextUsage),
    conversationId: readonly(conversationId),
    conversations: readonly(conversations),
    decide,
    disconnect,
    history: readonly(history),
    initialize,
    invokeCommand,
    items: readonly(items),
    newConversation,
    openConversation,
    pendingPermissionCount,
    reconnect,
    refreshConversations,
    run: readonly(run),
    selectAgent,
    selectedAgentId: readonly(selectedAgentId),
    send,
    sendContent,
    sendError: readonly(sendError),
    sendMode,
  }
})

function appendPending(pending: Map<string, ChatEvent[]>, event: ChatEvent): void {
  const events = pending.get(event.turnId)
  if (events === undefined) pending.set(event.turnId, [event])
  else events.push(event)
}

function historyEntrySignature(entry: ChatHistoryEntry): string | undefined {
  switch (entry.type) {
    case 'contextChange':
      return JSON.stringify([entry.type, entry.change, entry.replacedMessageIds, entry.text])
    case 'message':
      return JSON.stringify([entry.type, entry.text, entry.content])
    case 'reasoning':
      return JSON.stringify([entry.type, entry.text])
    case 'toolCall':
      return JSON.stringify([entry.type, entry.trackId, entry.name, entry.arguments])
    case 'toolResponse':
      return JSON.stringify([
        entry.type,
        entry.trackId,
        entry.name,
        entry.execution,
        entry.isError,
        entry.text,
        entry.content,
      ])
    case 'userMessage':
      return undefined
  }
}

function eventSignature(event: ChatEvent): string | undefined {
  switch (event.type) {
    case 'contextChange':
      return JSON.stringify([event.type, event.change, event.replacedMessageIds, event.text])
    case 'message':
      return JSON.stringify([event.type, event.text, event.content])
    case 'reasoning':
      return JSON.stringify([event.type, event.text])
    case 'toolCall':
      return JSON.stringify([event.type, event.trackId, event.name, event.arguments])
    case 'toolResponse':
      return JSON.stringify([
        event.type,
        event.trackId,
        event.name,
        event.execution,
        event.isError,
        event.text,
        event.content,
      ])
    case 'commandResult':
    case 'contextUsage':
    case 'error':
    case 'fragment':
    case 'permission':
    case 'permissionResolved':
    case 'reasoningFragment':
    case 'retry':
    case 'runCompleted':
    case 'runStarted':
    case 'title':
    case 'usage':
      return undefined
  }
}

type Translate = (
  key: string,
  parameters?: Readonly<Record<string, boolean | number | string>>,
) => string

function messageFor(error: unknown, t: Translate): string {
  if (error instanceof ApiError && error.code === 'chat_unavailable') {
    return t('chat.error.transportUnavailable')
  }
  if (error instanceof ApiError && error.status === 401) return t('chat.error.sessionUnauthorized')
  if (error instanceof ApiConnectionError) return t('chat.error.nodeDidNotAnswer')
  return t('chat.error.messageNotHandedOff')
}

function resourceMessageFor(error: unknown, action: string, t: Translate): string {
  if (error instanceof ApiError && error.code === 'chat_unavailable') {
    return t('chat.error.transportUnavailable')
  }
  if (error instanceof ApiError && error.code === 'conversation_not_found') {
    return t('chat.error.conversationMissing')
  }
  if (error instanceof ApiError && error.code === 'invalid_arguments') {
    return t('chat.error.invalidArguments', { action })
  }
  if (error instanceof ApiError && error.code === 'unknown_command') {
    return t('chat.error.commandUnavailable')
  }
  if (error instanceof ApiError && error.status === 401) return t('chat.error.sessionUnauthorized')
  if (error instanceof ApiContractError) return t('chat.error.invalidData', { action })
  if (error instanceof ApiConnectionError) return t('chat.error.nodeDidNotAnswer')
  return t('chat.error.couldNotAction', { action })
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
  ChatResourceState,
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
