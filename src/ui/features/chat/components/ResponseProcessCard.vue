<script setup lang="ts">
import { ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'

import ReasoningActivityCard from './ReasoningActivityCard.vue'
import ToolActivityCard from './ToolActivityCard.vue'

import type { ReasoningActivity, ToolActivity } from '../stores/activeSession.store'
import type { DeepReadonly } from 'vue'

type ProcessItem = ReasoningActivity | ToolActivity
interface Props {
  complete: boolean
  embedded?: boolean
  items: readonly DeepReadonly<ProcessItem>[]
}

const props = defineProps<Props>()
const { plural, t } = useI18n()
const expanded = ref(!props.complete)

watch(
  () => props.complete,
  (complete) => {
    expanded.value = !complete
  },
)

function toggleExpanded(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <section
    class="response-process"
    :class="{
      'response-process--active': !props.complete,
      'response-process--complete': props.complete,
      'response-process--embedded': props.embedded === true,
      'response-process--open': expanded,
    }"
  >
    <button
      class="response-process__summary"
      type="button"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <span class="response-process__signal" aria-hidden="true"></span>
      <span class="response-process__chevron" aria-hidden="true"></span>
      <strong>{{ t('chat.message.responseProcess') }}</strong>
      <span>{{ plural('chat.message.steps', props.items.length) }}</span>
    </button>

    <div class="response-process__viewport" :aria-hidden="!expanded" :inert="!expanded">
      <div class="response-process__body" :aria-label="t('chat.message.responseProcess')">
        <template v-for="item in props.items" :key="item.id">
          <ReasoningActivityCard v-if="item.kind === 'reasoning'" :item="item" />
          <ToolActivityCard v-else :item="item" />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.response-process {
  width: min(100%, 46rem);
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-action-primary);
  border-radius: var(--nox-radius-panel);
  border-end-start-radius: 0;
  color: var(--nox-text-muted);
  background: color-mix(in srgb, var(--nox-surface-1) 82%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  overflow: hidden;
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}

.response-process--open {
  border-color: var(--nox-border-strong);
  border-inline-start-color: var(--nox-action-primary);
  background: var(--nox-surface-1);
}

.response-process--embedded,
.response-process--embedded.response-process--open {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.response-process__summary {
  display: flex;
  width: 100%;
  min-height: 2.75rem;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.response-process__summary strong {
  min-width: 0;
  flex: 1;
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.response-process--complete:not(.response-process--open) .response-process__summary {
  min-height: 2.125rem;
  gap: var(--nox-space-2);
  padding-block: var(--nox-space-2);
  color: color-mix(in srgb, var(--nox-text-muted) 72%, transparent);
}

.response-process--complete:not(.response-process--open) .response-process__summary strong {
  color: var(--nox-text-muted);
  font-size: 0.65rem;
  font-weight: 600;
}

.response-process__signal {
  width: 0.5rem;
  height: 0.5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--nox-status-success);
}

.response-process--active .response-process__signal {
  background: var(--nox-action-primary);
  box-shadow: 0 0 0.75rem color-mix(in srgb, var(--nox-action-primary) 60%, transparent);
  animation: response-process-pulse 1.4s ease-in-out infinite;
}

.response-process--complete:not(.response-process--open) .response-process__signal {
  width: 0.3rem;
  height: 0.3rem;
  background: color-mix(in srgb, var(--nox-text-muted) 55%, transparent);
}

.response-process__chevron {
  width: 0.38rem;
  height: 0.38rem;
  flex: 0 0 auto;
  border-right: 1px solid currentcolor;
  border-bottom: 1px solid currentcolor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

.response-process--open > .response-process__summary > .response-process__chevron {
  transform: rotate(45deg) translate(-0.08rem, -0.08rem);
}

.response-process__viewport {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  overflow: hidden;
  transition:
    grid-template-rows 180ms ease,
    opacity 120ms ease;
}

.response-process--open .response-process__viewport {
  grid-template-rows: 1fr;
  opacity: 1;
}

.response-process__body {
  display: grid;
  min-width: 0;
  min-height: 0;
  gap: var(--nox-space-1);
  padding: 0 var(--nox-space-4) var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
  overflow: hidden;
}

.response-process__body :deep(.reasoning),
.response-process__body :deep(.tool) {
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

.response-process__body :deep(.reasoning) {
  border-inline-start-color: color-mix(in srgb, var(--nox-status-info) 55%, transparent);
}

.response-process__body :deep(.tool--complete) {
  border-inline-start-color: var(--nox-status-success);
}

.response-process__body :deep(.tool--error) {
  border-inline-start-color: var(--nox-status-danger);
}

.response-process__body :deep(.reasoning:not(:first-child)),
.response-process__body :deep(.tool:not(:first-child)) {
  border-top: 1px solid var(--nox-border-subtle);
}

@keyframes response-process-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .response-process {
    transition: none;
  }

  .response-process__chevron,
  .response-process__viewport {
    transition: none;
  }

  .response-process--active .response-process__signal {
    animation: none;
  }
}
</style>
