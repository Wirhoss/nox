<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue'

import type { ToolActivity } from '../stores/activeSession.store'

interface Props {
  item: DeepReadonly<ToolActivity>
}

const props = defineProps<Props>()

const state = computed(() => {
  const response = props.item.responses[props.item.responses.length - 1]
  if (response === undefined) return 'running'
  if (response.isError) return 'failed'
  switch (response.execution) {
    case 'deferredAck':
      return 'deferred'
    case 'permissionPending':
      return 'awaiting permission'
    case 'deferredResult':
    case 'immediate':
      return 'complete'
  }
  return 'running'
})

const tone = computed(() => {
  if (state.value === 'failed') return 'error'
  if (state.value === 'complete') return 'complete'
  return 'active'
})

function responseLabel(
  execution: DeepReadonly<ToolActivity>['responses'][number]['execution'],
): string {
  switch (execution) {
    case 'deferredAck':
      return 'Deferred acknowledgment'
    case 'deferredResult':
      return 'Deferred result'
    case 'immediate':
      return 'Result'
    case 'permissionPending':
      return 'Permission pending'
  }
}

function formatArguments(): string {
  return JSON.stringify(props.item.arguments ?? {}, undefined, 2)
}
</script>

<template>
  <article class="tool" :class="`tool--${tone}`">
    <header class="tool__header">
      <div>
        <span>Tool call</span>
        <strong>{{ props.item.name }}</strong>
      </div>
      <span>{{ state }}</span>
    </header>

    <details v-if="props.item.arguments !== undefined" class="tool__nested">
      <summary>Arguments</summary>
      <pre>{{ formatArguments() }}</pre>
    </details>

    <ol v-if="props.item.responses.length > 0" class="tool__responses">
      <li v-for="response in props.item.responses" :key="response.id">
        <details
          class="tool__nested tool__result"
          :class="{ 'tool__result--error': response.isError }"
        >
          <summary>
            <span>{{ responseLabel(response.execution) }}</span>
            <span>{{ response.isError ? 'error' : 'ok' }}</span>
          </summary>
          <pre>{{ response.text }}</pre>
        </details>
      </li>
    </ol>
  </article>
</template>

<style scoped lang="scss">
.tool {
  display: grid;
  width: min(100%, 46rem);
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-left: 2px solid var(--nox-status-info);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: color-mix(in srgb, var(--nox-surface-1) 76%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.tool--complete {
  border-left-color: var(--nox-status-success);
}

.tool--error {
  border-left-color: var(--nox-status-danger);
}

.tool__header,
.tool__header > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.tool__header {
  justify-content: space-between;
}

.tool__header span {
  color: var(--nox-text-muted);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tool__header strong {
  color: var(--nox-status-info);
  font-size: var(--nox-text-xs);
}

.tool--complete .tool__header > span {
  color: var(--nox-status-success);
}

.tool--error .tool__header > span {
  color: var(--nox-status-danger);
}

.tool__nested summary {
  color: var(--nox-text-muted);
  cursor: pointer;
}

.tool__nested pre {
  max-height: 14rem;
  margin: var(--nox-space-2) 0 0;
  padding: var(--nox-space-3);
  color: var(--nox-text-secondary);
  background: var(--nox-canvas);
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.tool__responses {
  display: grid;
  margin: 0;
  gap: var(--nox-space-2);
  padding: 0;
  list-style: none;
}

.tool__responses li {
  padding-top: var(--nox-space-2);
  border-top: 1px solid var(--nox-border-subtle);
}

.tool__result summary {
  display: flex;
  justify-content: space-between;
  gap: var(--nox-space-3);
}

.tool__result summary > span:last-child {
  color: var(--nox-status-success);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tool__result--error summary,
.tool__result--error summary > span:last-child,
.tool__result--error pre {
  color: var(--nox-status-danger);
}
</style>
