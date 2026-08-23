<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxNotice } from '@/shared/ui/NoxNotice'

import { useActiveSessionStore } from '../stores/activeSession.store'
import ChatMessage from './ChatMessage.vue'
import PermissionRequestCard from './PermissionRequestCard.vue'
import ReasoningActivityCard from './ReasoningActivityCard.vue'
import RunActivityCard from './RunActivityCard.vue'
import ToolActivityCard from './ToolActivityCard.vue'

const session = useActiveSessionStore()
const { t } = useI18n()
const timeline = ref<HTMLElement>()

type SessionItem = (typeof session.items)[number]
type AssistantItem = Extract<SessionItem, { readonly kind: 'assistant' }>
type ProcessItem = Extract<SessionItem, { readonly kind: 'reasoning' | 'tool' }>
type RunItem = Extract<SessionItem, { readonly kind: 'activity' }>
interface AssistantEntry {
  readonly activity?: RunItem
  readonly id: string
  readonly item: AssistantItem
  readonly kind: 'assistant'
  readonly processItems: readonly ProcessItem[]
}
interface ProcessEntry {
  readonly id: string
  readonly items: ProcessItem[]
  readonly kind: 'process'
  readonly turnId: string
}
type TimelineEntry =
  | AssistantEntry
  | ProcessEntry
  | { readonly id: string; readonly item: SessionItem; readonly kind: 'item' }

const timelineEntries = computed<TimelineEntry[]>(() => {
  const activityTargetByTurn = new Map<string, string>()
  const activityByTurn = new Map<string, RunItem>()
  const processTargetByItem = new Map<string, string>()
  const processItemsByAssistant = new Map<string, ProcessItem[]>()
  const nextAssistantByTurn = new Map<string, string>()

  for (const item of session.items) {
    if (item.kind === 'assistant') activityTargetByTurn.set(item.turnId, item.id)
    if (item.kind === 'activity') activityByTurn.set(item.turnId, item)
  }

  // One run can contain several provider replies. Walking backwards associates
  // each process step with its nearest following reply instead of collapsing the
  // whole run into the last assistant message.
  for (let index = session.items.length - 1; index >= 0; index -= 1) {
    const item = session.items[index]
    if (item === undefined) continue
    if (item.kind === 'assistant') {
      nextAssistantByTurn.set(item.turnId, item.id)
      continue
    }
    if (item.kind !== 'reasoning' && item.kind !== 'tool') continue

    const target = nextAssistantByTurn.get(item.turnId)
    if (target === undefined) continue
    processTargetByItem.set(item.id, target)
    const items = processItemsByAssistant.get(target) ?? []
    items.unshift(item)
    processItemsByAssistant.set(target, items)
  }

  const entries: TimelineEntry[] = []
  for (const item of session.items) {
    const activityTarget = 'turnId' in item ? activityTargetByTurn.get(item.turnId) : undefined

    if (item.kind === 'reasoning' || item.kind === 'tool') {
      if (processTargetByItem.has(item.id)) continue
      const previous = entries[entries.length - 1]
      if (previous?.kind === 'process' && previous.turnId === item.turnId) {
        previous.items.push(item)
      } else {
        entries.push({
          id: `process_${item.id}`,
          items: [item],
          kind: 'process',
          turnId: item.turnId,
        })
      }
      continue
    }

    if (item.kind === 'activity' && activityTarget !== undefined) continue
    if (item.kind === 'assistant') {
      const ownsActivity = activityTarget === item.id
      entries.push({
        activity: ownsActivity ? activityByTurn.get(item.turnId) : undefined,
        id: item.id,
        item,
        kind: 'assistant',
        processItems: processItemsByAssistant.get(item.id) ?? [],
      })
      continue
    }

    entries.push({ id: item.id, item, kind: 'item' })
  }
  return entries
})

watch(
  () => session.items,
  async () => {
    await nextTick()
    if (timeline.value !== undefined) timeline.value.scrollTop = timeline.value.scrollHeight
  },
  { deep: true },
)
</script>

<template>
  <section
    ref="timeline"
    class="timeline"
    :aria-label="t('chat.timeline.conversation')"
    aria-live="polite"
  >
    <NoxNotice
      v-if="session.history.type === 'loading'"
      class="timeline__state"
      :title="t('chat.timeline.loadingTitle')"
    >
      <p>{{ t('chat.timeline.loadingBody') }}</p>
    </NoxNotice>

    <NoxNotice
      v-else-if="session.history.type === 'failed'"
      class="timeline__state"
      :title="t('chat.timeline.unavailableTitle')"
      tone="danger"
    >
      <p>{{ session.history.message }}</p>
    </NoxNotice>

    <div v-else-if="session.items.length === 0" class="timeline__empty">
      <p class="timeline__eyebrow">{{ t('chat.timeline.online') }}</p>
      <h2>{{ t('chat.timeline.emptyTitle') }}</h2>
      <p>{{ t('chat.timeline.emptyBody') }}</p>
    </div>

    <template v-for="entry in timelineEntries" :key="entry.id">
      <ChatMessage
        v-if="entry.kind === 'assistant'"
        :activity="entry.activity"
        :item="entry.item"
        :process-items="entry.processItems"
      />

      <section
        v-else-if="entry.kind === 'process'"
        class="timeline__process"
        :aria-label="t('chat.message.responseProcess')"
      >
        <template v-for="processItem in entry.items" :key="processItem.id">
          <ReasoningActivityCard v-if="processItem.kind === 'reasoning'" :item="processItem" />
          <ToolActivityCard v-else :item="processItem" />
        </template>
      </section>

      <template v-else>
        <ChatMessage v-if="entry.item.kind === 'user'" :item="entry.item" />

        <NoxNotice
          v-else-if="entry.item.kind === 'error'"
          :title="t('chat.run.failed')"
          tone="danger"
        >
          <p>{{ entry.item.text }}</p>
        </NoxNotice>

        <RunActivityCard v-else-if="entry.item.kind === 'activity'" :item="entry.item" />

        <PermissionRequestCard
          v-else-if="entry.item.kind === 'permission'"
          :item="entry.item"
          @decide="(requestId, decision) => session.decide(requestId, decision)"
        />
      </template>
    </template>
  </section>
</template>

<style scoped lang="scss">
.timeline {
  display: grid;
  min-height: 0;
  align-content: start;
  grid-auto-rows: max-content;
  gap: var(--nox-space-8);
  padding: var(--nox-space-10) max(var(--nox-space-6), calc((100% - 52rem) / 2));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--nox-border-strong) transparent;
}

.timeline__process {
  display: grid;
  width: min(100%, 46rem);
  height: auto;
  max-height: none;
  align-self: start;
  gap: var(--nox-space-1);
}

.timeline__process :deep(.reasoning),
.timeline__process :deep(.tool) {
  display: block;
  width: 100%;
  height: auto;
  max-height: none;
  min-height: 2.65rem;
  border: 0;
  border-inline-start: 2px solid var(--nox-status-info);
  border-radius: 0;
  background: transparent;
  overflow: visible;
}

.timeline__process :deep(.reasoning) {
  border-inline-start-color: color-mix(in srgb, var(--nox-status-info) 55%, transparent);
}

.timeline__process :deep(.tool--complete) {
  border-inline-start-color: var(--nox-status-success);
}

.timeline__process :deep(.tool--error) {
  border-inline-start-color: var(--nox-status-danger);
}

.timeline__process :deep(.reasoning:not(:first-child)),
.timeline__process :deep(.tool:not(:first-child)) {
  border-top: 1px solid var(--nox-border-subtle);
}

.timeline__state {
  width: min(100%, 38rem);
  margin: auto;
}

.timeline__empty {
  width: min(100%, 38rem);
  margin: auto;
  align-self: center;
  text-align: center;
}

.timeline__eyebrow {
  margin: 0;
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
}

.timeline__empty h2 {
  margin: var(--nox-space-4) 0 var(--nox-space-2);
  font-size: var(--nox-text-xl);
  letter-spacing: -0.04em;
  line-height: var(--nox-leading-tight);
}

.timeline__empty > p:last-child {
  margin: 0;
  color: var(--nox-text-secondary);
}
</style>
