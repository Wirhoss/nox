<script setup lang="ts">
import type { AssistantItem, UserItem } from '../stores/activeSession.store'

interface Props {
  item: AssistantItem | UserItem
}

const props = defineProps<Props>()
</script>

<template>
  <article class="message" :class="`message--${props.item.kind}`">
    <header class="message__author">{{ props.item.kind === 'user' ? 'YOU' : 'NOX' }}</header>
    <p class="message__text">
      {{ props.item.text }}<span
        v-if="props.item.kind === 'assistant' && props.item.streaming"
        class="message__cursor"
        aria-label="Nox is writing"
      ></span>
    </p>
  </article>
</template>

<style scoped lang="scss">
.message {
  display: grid;
  max-width: 46rem;
  gap: var(--nox-space-2);
}

.message--user {
  justify-self: end;
  width: min(88%, 38rem);
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-panel) var(--nox-radius-panel) 0 var(--nox-radius-panel);
  background: var(--nox-surface-2);
}

.message__author {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
}

.message--assistant .message__author {
  color: var(--nox-action-primary);
}

.message__text {
  margin: 0;
  color: var(--nox-text-primary);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.message__cursor {
  display: inline-block;
  width: 0.55rem;
  height: 1em;
  margin-left: var(--nox-space-1);
  background: var(--nox-action-primary);
  vertical-align: -0.12em;
  animation: blink 1s steps(2, jump-none) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message__cursor {
    animation: none;
  }
}
</style>
