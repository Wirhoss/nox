<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue'

import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'

import type { PermissionDecision } from '../api/chat.api'
import type { PermissionItem } from '../stores/activeSession.store'

interface Props {
  item: DeepReadonly<PermissionItem>
}

const props = defineProps<Props>()
const emit = defineEmits<{ decide: [requestId: string, decision: PermissionDecision] }>()

const isClosed = computed(() => props.item.state.type === 'resolved')
const isSubmitting = computed(() => props.item.state.type === 'submitting')
const params = computed(() => JSON.stringify(props.item.request.params, undefined, 2))
const outcome = computed(() => {
  if (props.item.state.type !== 'resolved') return undefined
  const { resolution, scope } = props.item.state.outcome
  if (resolution !== 'approved') return resolution
  return scope === 'session' ? 'approved for session' : 'approved once'
})

function decide(decision: PermissionDecision): void {
  emit('decide', props.item.request.requestId, decision)
}
</script>

<template>
  <article class="permission" :class="{ 'permission--closed': isClosed }">
    <header class="permission__header">
      <div>
        <p class="permission__eyebrow">Permission required</p>
        <h2>{{ props.item.request.title }}</h2>
      </div>
      <span class="permission__state">{{ outcome ?? props.item.state.type }}</span>
    </header>

    <div class="permission__body">
      <p class="permission__reason">{{ props.item.request.reason }}</p>

      <blockquote v-if="props.item.request.preview !== undefined" class="permission__preview">
        {{ props.item.request.preview }}
      </blockquote>

      <dl class="permission__facts">
        <div>
          <dt>Tool</dt>
          <dd>{{ props.item.request.toolName }}</dd>
        </div>
        <div>
          <dt>Tool set</dt>
          <dd>{{ props.item.request.toolSetId }}</dd>
        </div>
        <div v-if="props.item.request.risk?.reversible !== undefined">
          <dt>Reversible</dt>
          <dd>{{ props.item.request.risk.reversible ? 'Yes' : 'No' }}</dd>
        </div>
      </dl>

      <ul v-if="props.item.request.signals.length > 0" class="permission__signals">
        <li v-for="signal in props.item.request.signals" :key="signal.code">
          <span>{{ signal.severity }}</span>
          {{ signal.reason }}
        </li>
      </ul>

      <NoxNotice
        v-if="props.item.state.type === 'failed'"
        title="Decision was not delivered"
        tone="danger"
      >
        <p>{{ props.item.state.message }}</p>
      </NoxNotice>

      <details class="permission__details">
        <summary>Technical details</summary>
        <pre>{{ params }}</pre>
      </details>
    </div>

    <footer v-if="!isClosed" class="permission__actions">
      <NoxButton
        :disabled="isSubmitting"
        variant="ghost"
        @click="decide({ decision: 'deny' })"
      >
        Deny
      </NoxButton>
      <div>
        <NoxButton
          :disabled="isSubmitting"
          variant="secondary"
          @click="decide({ decision: 'approve', scope: 'once' })"
        >
          Approve once
        </NoxButton>
        <NoxButton
          :disabled="isSubmitting"
          @click="decide({ decision: 'approve', scope: 'session' })"
        >
          Approve for session
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.permission {
  width: min(100%, 46rem);
  border: 1px solid var(--nox-status-warning);
  border-radius: var(--nox-radius-panel);
  background: var(--nox-surface-1);
  box-shadow: var(--nox-shadow-panel);
  overflow: hidden;
}

.permission--closed {
  border-color: var(--nox-border-subtle);
  box-shadow: none;
  opacity: 0.78;
}

.permission__header,
.permission__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-5);
  background: var(--nox-canvas-raised);
}

.permission__header {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.permission__eyebrow,
.permission__state {
  margin: 0;
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.permission__header h2 {
  margin: var(--nox-space-1) 0 0;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-md);
}

.permission__state {
  color: var(--nox-text-muted);
  white-space: nowrap;
}

.permission__body {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
}

.permission__reason,
.permission__preview {
  margin: 0;
}

.permission__reason {
  color: var(--nox-text-secondary);
}

.permission__preview {
  padding: var(--nox-space-4);
  border-left: 2px solid var(--nox-status-warning);
  color: var(--nox-text-primary);
  background: var(--nox-surface-2);
  white-space: pre-wrap;
}

.permission__facts {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--nox-space-3);
}

.permission__facts div {
  padding-top: var(--nox-space-2);
  border-top: 1px solid var(--nox-border-subtle);
}

.permission__facts dt,
.permission__facts dd {
  margin: 0;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  overflow-wrap: anywhere;
}

.permission__facts dt {
  color: var(--nox-text-muted);
  text-transform: uppercase;
}

.permission__facts dd {
  margin-top: var(--nox-space-1);
  color: var(--nox-text-secondary);
}

.permission__signals {
  display: grid;
  margin: 0;
  gap: var(--nox-space-2);
  padding: 0;
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-sm);
  list-style: none;
}

.permission__signals span {
  margin-right: var(--nox-space-2);
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  text-transform: uppercase;
}

.permission__details {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.permission__details summary {
  cursor: pointer;
}

.permission__details pre {
  max-height: 14rem;
  margin: var(--nox-space-3) 0 0;
  padding: var(--nox-space-3);
  background: var(--nox-surface-input);
  overflow: auto;
}

.permission__actions {
  border-top: 1px solid var(--nox-border-subtle);
}

.permission__actions > div {
  display: flex;
  gap: var(--nox-space-2);
}

@media (max-width: 42rem) {
  .permission__header,
  .permission__actions,
  .permission__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .permission__facts {
    grid-template-columns: 1fr;
  }
}
</style>
