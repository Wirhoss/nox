<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import { NoxNotice } from '@/shared/ui/NoxNotice'

import { useActiveSessionStore } from '../stores/activeSession.store'
import ChatMessage from './ChatMessage.vue'
import PermissionRequestCard from './PermissionRequestCard.vue'
import RunActivityCard from './RunActivityCard.vue'

const session = useActiveSessionStore()
const timeline = ref<HTMLElement>()

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
  <section ref="timeline" class="timeline" aria-label="Conversation" aria-live="polite">
    <div v-if="session.items.length === 0" class="timeline__empty">
      <p class="timeline__eyebrow">NOX ONLINE</p>
      <h2>What needs to be done?</h2>
      <p>Start a new conversation through the configured web surface.</p>
    </div>

    <template v-for="item in session.items" :key="item.id">
      <ChatMessage v-if="item.kind === 'assistant' || item.kind === 'user'" :item="item" />

      <NoxNotice v-else-if="item.kind === 'error'" title="Run failed" tone="danger">
        <p>{{ item.text }}</p>
      </NoxNotice>

      <RunActivityCard v-else-if="item.kind === 'activity'" :item="item" />

      <PermissionRequestCard
        v-else-if="item.kind === 'permission'"
        :item="item"
        @decide="(requestId, decision) => session.decide(requestId, decision)"
      />
    </template>
  </section>
</template>

<style scoped lang="scss">
.timeline {
  display: grid;
  align-content: start;
  gap: var(--nox-space-8);
  padding: var(--nox-space-10) max(var(--nox-space-6), calc((100% - 52rem) / 2));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--nox-border-strong) transparent;
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
