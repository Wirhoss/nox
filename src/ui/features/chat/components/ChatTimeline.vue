<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxNotice } from '@/shared/ui/NoxNotice'

import { useActiveSessionStore } from '../stores/activeSession.store'
import AssistantResponseCard from './AssistantResponseCard.vue'
import ChatMessage from './ChatMessage.vue'

const session = useActiveSessionStore()
const { t } = useI18n()
const timeline = ref<HTMLElement>()

type SessionItem = (typeof session.items)[number]
type ResponseItem = Extract<
  SessionItem,
  { readonly kind: 'assistant' | 'error' | 'permission' | 'reasoning' | 'tool' }
>
type RunItem = Extract<SessionItem, { readonly kind: 'activity' }>
type UserItem = Extract<SessionItem, { readonly kind: 'user' }>
interface ResponseEntry {
  readonly activities: RunItem[]
  readonly id: string
  readonly items: ResponseItem[]
  readonly kind: 'response'
  redirected: boolean
}
type TimelineEntry =
  ResponseEntry | { readonly id: string; readonly item: UserItem; readonly kind: 'item' }

const timelineEntries = computed<TimelineEntry[]>(() => {
  const entries: TimelineEntry[] = []
  const activitiesByTurn = new Map<string, RunItem[]>()
  let currentResponse: ResponseEntry | undefined

  const responseFor = (turnId: string): ResponseEntry => {
    if (currentResponse !== undefined) return currentResponse

    currentResponse = {
      // A steer splits one run into visual response segments. Each segment keeps
      // the same run activity so its active/completed state remains truthful.
      activities: [...(activitiesByTurn.get(turnId) ?? [])],
      id: `response_${turnId}_${String(entries.length)}`,
      items: [],
      kind: 'response',
      redirected: false,
    }
    entries.push(currentResponse)
    return currentResponse
  }

  for (const item of session.items) {
    switch (item.kind) {
      case 'activity': {
        const activities = activitiesByTurn.get(item.turnId) ?? []
        if (!activities.includes(item)) activities.push(item)
        activitiesByTurn.set(item.turnId, activities)
        const response = responseFor(item.turnId)
        if (!response.activities.includes(item)) response.activities.push(item)
        break
      }
      case 'assistant':
      case 'error':
      case 'permission':
      case 'reasoning':
      case 'tool':
        responseFor(item.turnId).items.push(item)
        break
      case 'user': {
        if (item.mode === 'steer' && currentResponse !== undefined) {
          currentResponse.redirected = true
          // Run details follow the still-active segment below the marker. The
          // response above it is closed by the steer itself.
          currentResponse.activities.splice(0)
        }
        currentResponse = undefined
        entries.push({ id: item.id, item, kind: 'item' })
        if (item.steeredTurnId !== undefined) responseFor(item.steeredTurnId)
        break
      }
    }
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
      <AssistantResponseCard
        v-if="entry.kind === 'response'"
        :activities="entry.activities"
        :items="entry.items"
        :redirected="entry.redirected"
        @decide="(requestId, decision) => session.decide(requestId, decision)"
      />

      <ChatMessage v-else :item="entry.item" />
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
