<script setup lang="ts">
import { ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'

import type { ReasoningActivity } from '../stores/activeSession.store'
import type { DeepReadonly } from 'vue'

interface Props {
  item: DeepReadonly<ReasoningActivity>
}

const props = defineProps<Props>()
const { t } = useI18n()
const expanded = ref(props.item.streaming)

watch(
  () => props.item.streaming,
  (streaming) => {
    expanded.value = streaming
  },
)

function syncExpanded(event: Event): void {
  if (event.currentTarget instanceof HTMLDetailsElement) {
    expanded.value = event.currentTarget.open
  }
}
</script>

<template>
  <details
    class="reasoning"
    :open="expanded"
    :aria-label="t('chat.reasoning.nextResponse')"
    @toggle="syncExpanded"
  >
    <summary class="reasoning__header">
      <span class="reasoning__chevron" aria-hidden="true"></span>
      <span class="reasoning__label">{{ t('chat.reasoning.label') }}</span>
      <span class="reasoning__state">{{
        props.item.streaming ? t('chat.reasoning.streaming') : t('chat.reasoning.settled')
      }}</span>
    </summary>
    <div class="reasoning__body">
      <p>
        {{ props.item.text
        }}<span
          v-if="props.item.streaming"
          class="reasoning__cursor"
          :aria-label="t('chat.reasoning.streamingLabel')"
        ></span>
      </p>
    </div>
  </details>
</template>

<style scoped lang="scss">
.reasoning {
  width: min(100%, 46rem);
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid color-mix(in srgb, var(--nox-status-info) 55%, transparent);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-muted);
  background: color-mix(in srgb, var(--nox-surface-1) 68%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  overflow: hidden;
}

.reasoning__header {
  display: flex;
  min-height: 2.65rem;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  cursor: pointer;
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  list-style: none;
  text-transform: uppercase;
}

.reasoning__header::-webkit-details-marker {
  display: none;
}

.reasoning__chevron {
  width: 0.42rem;
  height: 0.42rem;
  flex: 0 0 auto;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

.reasoning[open] > .reasoning__header > .reasoning__chevron {
  transform: rotate(45deg) translate(-0.08rem, -0.08rem);
}

.reasoning__label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reasoning__state {
  flex: 0 0 auto;
  opacity: 0.72;
}

.reasoning__body {
  padding: var(--nox-space-3) var(--nox-space-4) var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.reasoning p {
  margin: 0;
  color: color-mix(in srgb, var(--nox-text-secondary) 74%, transparent);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.reasoning__cursor {
  display: inline-block;
  width: 0.45rem;
  height: 0.9em;
  margin-inline-start: var(--nox-space-1);
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
  .reasoning__chevron {
    transition: none;
  }

  .reasoning__cursor {
    animation: none;
  }
}
</style>
