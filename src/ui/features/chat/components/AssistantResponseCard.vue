<script setup lang="ts">
import { computed, type DeepReadonly, ref } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxNotice } from '@/shared/ui/NoxNotice'

import ChatMessage from './ChatMessage.vue'
import PermissionRequestCard from './PermissionRequestCard.vue'
import ResponseProcessCard from './ResponseProcessCard.vue'
import RunActivityCard from './RunActivityCard.vue'

import type { PermissionDecision } from '../api/chat.api'
import type {
  AssistantItem,
  ErrorItem,
  PermissionItem,
  ReasoningActivity,
  RunActivityItem,
  ToolActivity,
} from '../stores/activeSession.store'

type ProcessItem = ReasoningActivity | ToolActivity
type ResponseItem = AssistantItem | ErrorItem | PermissionItem | ProcessItem
type ReadonlyAssistantItem = DeepReadonly<AssistantItem>
type ReadonlyProcessItem = DeepReadonly<ProcessItem>
interface Props {
  activities: readonly DeepReadonly<RunActivityItem>[]
  items: readonly DeepReadonly<ResponseItem>[]
  redirected?: boolean
}
interface AssistantBlock {
  item: ReadonlyAssistantItem
  readonly kind: 'assistant'
  readonly showAuthor: boolean
}
interface ErrorBlock {
  readonly item: DeepReadonly<ErrorItem>
  readonly kind: 'error'
}
interface PermissionBlock {
  readonly item: DeepReadonly<PermissionItem>
  readonly kind: 'permission'
}
interface ProcessBlock {
  readonly id: string
  readonly items: ReadonlyProcessItem[]
  readonly kind: 'process'
}
type ResponseBlock = AssistantBlock | ErrorBlock | PermissionBlock | ProcessBlock

const props = defineProps<Props>()
const emit = defineEmits<{ decide: [requestId: string, decision: PermissionDecision] }>()
const { formatDate, t } = useI18n()
const detailsOpen = ref(false)
const currentActivity = computed(() => props.activities[props.activities.length - 1])
const lastAssistant = computed(() => {
  for (let index = props.items.length - 1; index >= 0; index -= 1) {
    const item = props.items[index]
    if (item?.kind === 'assistant') return item
  }
  return undefined
})
const timestamp = computed(() =>
  lastAssistant.value === undefined
    ? undefined
    : formatDate(lastAssistant.value.createdAt, { dateStyle: 'medium', timeStyle: 'short' }),
)

const blocks = computed<ResponseBlock[]>(() => {
  const projected: ResponseBlock[] = []
  let hasAssistant = false
  for (const item of props.items) {
    const previous = projected[projected.length - 1]
    switch (item.kind) {
      case 'assistant':
        if (previous?.kind === 'assistant') previous.item = mergeAssistantItems(previous.item, item)
        else {
          projected.push({ item, kind: 'assistant', showAuthor: !hasAssistant })
          hasAssistant = true
        }
        break
      case 'error':
        projected.push({ item, kind: 'error' })
        break
      case 'permission':
        projected.push({ item, kind: 'permission' })
        break
      case 'reasoning':
      case 'tool':
        if (previous?.kind === 'process') previous.items.push(item)
        else projected.push({ id: `process_${item.id}`, items: [item], kind: 'process' })
        break
    }
  }
  return projected
})

function processComplete(index: number): boolean {
  if (props.redirected) return true
  for (let next = index + 1; next < blocks.value.length; next += 1) {
    const block = blocks.value[next]
    if (block?.kind === 'process') break
    if (block?.kind === 'assistant') return true
  }
  return currentActivity.value?.status !== undefined
}

function mergeAssistantItems(
  first: ReadonlyAssistantItem,
  second: ReadonlyAssistantItem,
): AssistantItem {
  return {
    content: [...contentFromAssistant(first), ...contentFromAssistant(second)],
    createdAt: first.createdAt,
    id: first.id,
    kind: 'assistant',
    media: [...first.media, ...second.media],
    streaming: first.streaming || second.streaming,
    text: [first.text, second.text].filter((text) => text.length > 0).join('\n\n'),
    turnId: first.turnId,
  }
}

function contentFromAssistant(item: ReadonlyAssistantItem): NonNullable<AssistantItem['content']> {
  if (item.content !== undefined) return item.content
  return [
    ...item.media,
    ...(item.text.length === 0 ? [] : [{ text: item.text, type: 'text' as const }]),
  ]
}
</script>

<template>
  <article
    class="assistant-response"
    :class="{
      'assistant-response--active':
        currentActivity?.status === undefined && props.redirected !== true,
      'assistant-response--answered': blocks.some((block) => block.kind === 'assistant'),
      'assistant-response--redirected': props.redirected === true,
    }"
  >
    <div v-if="blocks.length === 0" class="assistant-response__waiting">
      <span class="assistant-response__signal" aria-hidden="true"></span>
      <strong>NOX</strong>
      <span>{{ t('chat.activity.active') }}</span>
    </div>

    <template
      v-for="(block, index) in blocks"
      :key="block.kind === 'process' ? block.id : block.item.id"
    >
      <ResponseProcessCard
        v-if="block.kind === 'process'"
        :complete="processComplete(index)"
        embedded
        :items="block.items"
      />
      <ChatMessage
        v-else-if="block.kind === 'assistant'"
        embedded
        :item="block.item"
        :show-author="block.showAuthor"
        :show-timestamp="false"
      />
      <PermissionRequestCard
        v-else-if="block.kind === 'permission'"
        :item="block.item"
        @decide="(requestId, decision) => emit('decide', requestId, decision)"
      />
      <NoxNotice v-else :title="t('chat.run.failed')" tone="danger">
        <p>{{ block.item.text }}</p>
      </NoxNotice>
    </template>

    <footer
      v-if="lastAssistant !== undefined || props.activities.length > 0"
      class="assistant-response__footer"
    >
      <time
        v-if="lastAssistant !== undefined"
        class="assistant-response__timestamp"
        :datetime="lastAssistant.createdAt"
        :title="lastAssistant.createdAt"
      >
        {{ timestamp }}
      </time>

      <button
        v-if="props.activities.length > 0"
        class="assistant-response__details-summary"
        type="button"
        :aria-expanded="detailsOpen"
        @click="detailsOpen = !detailsOpen"
      >
        <span
          class="assistant-response__details-chevron"
          :class="{ 'assistant-response__details-chevron--open': detailsOpen }"
          aria-hidden="true"
        ></span>
        <span>{{ t('common.details') }}</span>
      </button>

      <div v-if="detailsOpen" class="assistant-response__details-body">
        <RunActivityCard
          v-for="activity in props.activities"
          :key="activity.id"
          embedded
          :item="activity"
        />
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.assistant-response {
  display: grid;
  width: min(100%, 46rem);
  min-width: 0;
  justify-self: start;
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-action-primary);
  border-radius: var(--nox-radius-panel);
  border-end-start-radius: 0;
  background: var(--nox-surface-1);
  overflow: hidden;
  transition: border-color 160ms ease;
}

.assistant-response--active {
  border-color: var(--nox-border-strong);
  border-inline-start-color: var(--nox-action-primary);
}

.assistant-response--redirected {
  border-block-end-color: color-mix(in srgb, var(--nox-status-warning) 48%, var(--nox-border-subtle));
  border-end-start-radius: var(--nox-radius-panel);
  opacity: 0.86;
}

.assistant-response > :deep(* + *) {
  border-top: 1px solid var(--nox-border-subtle);
}

.assistant-response :deep(.response-process--embedded),
.assistant-response :deep(.message--embedded),
.assistant-response :deep(.permission) {
  width: 100%;
}

.assistant-response :deep(.permission) {
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.assistant-response
  :deep(.response-process--complete:not(.response-process--open) + .message--embedded) {
  padding-top: var(--nox-space-1);
  border-top: 0;
}

.assistant-response--answered :deep(.message--embedded) {
  animation: assistant-response-arrive 180ms ease-out both;
}

.assistant-response__waiting {
  display: flex;
  min-height: 3rem;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.assistant-response__waiting strong {
  color: var(--nox-action-primary);
  letter-spacing: var(--nox-tracking-system);
}

.assistant-response__signal {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--nox-action-primary);
  box-shadow: 0 0 0.75rem color-mix(in srgb, var(--nox-action-primary) 60%, transparent);
  animation: assistant-response-pulse 1.4s ease-in-out infinite;
}

.assistant-response__footer {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  padding: var(--nox-space-3) var(--nox-space-6);
}

.assistant-response__timestamp {
  grid-column: 1;
  grid-row: 1;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.04em;
}

.assistant-response__details-summary {
  display: flex;
  width: max-content;
  align-items: center;
  gap: var(--nox-space-2);
  padding: 0;
  border: 0;
  margin-inline-start: auto;
  color: var(--nox-text-muted);
  background: transparent;
  cursor: pointer;
  font-family: var(--nox-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.assistant-response__details-chevron {
  width: 0.38rem;
  height: 0.38rem;
  border-right: 1px solid currentcolor;
  border-bottom: 1px solid currentcolor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

.assistant-response__details-chevron--open {
  transform: rotate(45deg) translate(-0.08rem, -0.08rem);
}

.assistant-response__details-body {
  grid-column: 1 / -1;
  padding-top: var(--nox-space-4);
  margin-top: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

@keyframes assistant-response-arrive {
  from {
    opacity: 0;
    transform: translateY(var(--nox-space-2));
  }
}

@keyframes assistant-response-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .assistant-response,
  .assistant-response__details-chevron {
    transition: none;
  }

  .assistant-response--answered :deep(.message--embedded),
  .assistant-response__signal {
    animation: none;
  }
}
</style>
