import type { PermissionDecision } from '../api/chat.api'
import type {
  ChatContentPart,
  ChatEvent,
  ChatHistory,
  ChatMediaPart,
  ChatPermissionRequest,
  ChatUsage,
  PermissionOutcome,
} from '../api/chat.schemas'
import type { Ref } from 'vue'

type RunCompletionStatus = Extract<ChatEvent, { type: 'runCompleted' }>['status']
type RunTrigger = Extract<ChatEvent, { type: 'runStarted' }>['trigger']
type ToolResponseExecution = Extract<ChatEvent, { type: 'toolResponse' }>['execution']

interface AssistantItem {
  content?: readonly ChatContentPart[]
  readonly createdAt: string
  readonly id: string
  readonly kind: 'assistant'
  media: readonly ChatMediaPart[]
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

type PermissionState =
  | { readonly decision: PermissionDecision; readonly type: 'submitting' }
  | { readonly message: string; readonly type: 'failed' }
  | { readonly outcome: PermissionOutcome; readonly type: 'resolved' }
  | { readonly type: 'pending' }

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
  readonly media: readonly ChatMediaPart[]
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
  historical?: boolean
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
  readonly media: readonly ChatMediaPart[]
  /** `observation` only arrives from history; this surface never sends one. */
  readonly mode: 'message' | 'observation' | 'steer'
  /** The live run this item visually divides; history already carries real ordering. */
  readonly steeredTurnId?: string
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

interface TimelineProjection {
  readonly activityItem: (turnId: string) => RunActivityItem
  readonly appendFragment: (turnId: string, text: string) => void
  readonly appendReasoningFragment: (turnId: string, text: string) => void
  readonly discardStreamingDrafts: (turnId: string) => void
  readonly insertBeforeRunSummary: (turnId: string, item: TimelineItem) => void
  readonly permissionItem: (requestId: string) => PermissionItem | undefined
  readonly projectHistory: (loaded: ChatHistory) => void
  readonly settleMessage: (
    turnId: string,
    text: string,
    content?: readonly ChatContentPart[],
  ) => void
  readonly settleReasoning: (turnId: string, text: string) => void
  readonly toolActivity: (
    activity: RunActivityItem,
    trackId: string,
    name: string,
  ) => ToolActivity
}

/**
 * Owns transcript projection and ordering. The store coordinates transport and
 * resource state; this projection owns how history and live run events become
 * mutable timeline rows.
 */
function createTimeline(items: Ref<TimelineItem[]>): TimelineProjection {
  function projectHistory(loaded: ChatHistory): void {
    items.value = []
    let turn = 0

    for (const entry of loaded.entries) {
      if (entry.type === 'userMessage') {
        turn += 1
        items.value.push({
          createdAt: entry.at,
          id: entry.messageId,
          kind: 'user',
          media: mediaFrom(entry.content),
          mode: entry.mode,
          text: entry.text,
        })
        continue
      }

      const turnId = `history_${String(turn)}`
      switch (entry.type) {
        case 'contextChange': {
          const activity = historicalActivity(turnId)
          activity.contextChanges.push({
            change: entry.change,
            id: entry.messageId,
            replacedMessageIds: entry.replacedMessageIds,
            text: entry.text,
          })
          break
        }
        case 'message':
          insertBeforeRunSummary(turnId, {
            content: entry.content,
            createdAt: entry.at,
            id: entry.messageId,
            kind: 'assistant',
            media: mediaFrom(entry.content),
            streaming: false,
            text: entry.text,
            turnId,
          })
          break
        case 'reasoning': {
          const activity = historicalActivity(turnId)
          const reasoning: ReasoningActivity = {
            id: entry.messageId,
            kind: 'reasoning',
            streaming: false,
            text: entry.text,
            turnId,
          }
          activity.reasoning.push(reasoning)
          insertBeforeRunSummary(turnId, reasoning)
          break
        }
        case 'toolCall': {
          const tool = toolActivity(historicalActivity(turnId), entry.trackId, entry.name)
          tool.arguments = entry.arguments
          break
        }
        case 'toolResponse': {
          const tool = toolActivity(historicalActivity(turnId), entry.trackId, entry.name)
          tool.responses.push({
            execution: entry.execution,
            id: entry.messageId,
            isError: entry.isError,
            media: mediaFrom(entry.content),
            text: entry.text,
          })
          break
        }
      }
    }
  }

  function historicalActivity(turnId: string): RunActivityItem {
    const activity = activityItem(turnId)
    activity.historical = true
    return activity
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
      media: [],
      streaming: true,
      text,
      turnId,
    })
  }

  function settleMessage(
    turnId: string,
    text: string,
    content?: readonly ChatContentPart[],
  ): void {
    const media = mediaFrom(content)
    const existing = streamingAssistantItem(turnId)
    if (existing !== undefined) {
      existing.content = content
      existing.text = text
      existing.media = media
      existing.streaming = false
      return
    }

    insertBeforeRunSummary(turnId, {
      content,
      createdAt: new Date().toISOString(),
      id: createId('assistant'),
      kind: 'assistant',
      media,
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
      id: `tool_${activity.turnId}_${trackId}`,
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

    // A steer is a visible cut through one long run. New response-process items
    // belong below its marker instead of jumping back above the run summary.
    let steerIndex = -1
    for (let index = items.value.length - 1; index > summaryIndex; index -= 1) {
      const candidate = items.value[index]
      if (
        candidate?.kind === 'user' &&
        candidate.mode === 'steer' &&
        candidate.steeredTurnId === turnId
      ) {
        steerIndex = index
        break
      }
    }
    if (steerIndex > summaryIndex) {
      let insertionIndex = steerIndex + 1
      while (turnIdOf(items.value[insertionIndex]) === turnId) insertionIndex += 1
      items.value.splice(insertionIndex, 0, item)
      return
    }

    items.value.splice(summaryIndex, 0, item)
  }

  return {
    activityItem,
    appendFragment,
    appendReasoningFragment,
    discardStreamingDrafts,
    insertBeforeRunSummary,
    permissionItem,
    projectHistory,
    settleMessage,
    settleReasoning,
    toolActivity,
  }
}

function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${value}`
}

function mediaFrom(content: readonly ChatContentPart[] | undefined): readonly ChatMediaPart[] {
  return content?.filter((part): part is ChatMediaPart => part.type !== 'text') ?? []
}

function turnIdOf(item: TimelineItem | undefined): string | undefined {
  return item === undefined || item.kind === 'user' ? undefined : item.turnId
}

export { createId, createTimeline, mediaFrom }

export type {
  AssistantItem,
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
