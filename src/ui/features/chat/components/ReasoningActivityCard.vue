<script setup lang="ts">
import { type DeepReadonly } from 'vue'

import type { ReasoningActivity } from '../stores/activeSession.store'

interface Props {
  item: DeepReadonly<ReasoningActivity>
}

const props = defineProps<Props>()
</script>

<template>
  <aside class="reasoning" aria-label="Reasoning for the next response">
    <header class="reasoning__header">
      <span>Reasoning for response</span>
      <span>{{ props.item.streaming ? 'streaming' : 'settled' }}</span>
    </header>
    <p>
      {{ props.item.text }}<span
        v-if="props.item.streaming"
        class="reasoning__cursor"
        aria-label="Nox reasoning is streaming"
      ></span>
    </p>
  </aside>
</template>

<style scoped lang="scss">
.reasoning {
  width: min(100%, 46rem);
  padding: var(--nox-space-3) var(--nox-space-4);
  border-left: 2px solid color-mix(in srgb, var(--nox-status-info) 55%, transparent);
  color: var(--nox-text-muted);
  background: color-mix(in srgb, var(--nox-surface-input) 58%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.reasoning__header {
  display: flex;
  justify-content: space-between;
  gap: var(--nox-space-3);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.reasoning__header > span:last-child {
  opacity: 0.72;
}

.reasoning p {
  margin: var(--nox-space-2) 0 0;
  color: color-mix(in srgb, var(--nox-text-secondary) 74%, transparent);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.reasoning__cursor {
  display: inline-block;
  width: 0.45rem;
  height: 0.9em;
  margin-left: var(--nox-space-1);
  background: var(--nox-status-info);
  vertical-align: -0.1em;
  animation: reasoning-blink 1s steps(2, jump-none) infinite;
}

@keyframes reasoning-blink {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning__cursor {
    animation: none;
  }
}
</style>
