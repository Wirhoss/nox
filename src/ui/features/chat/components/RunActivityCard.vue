<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue'

import type { ChatUsage } from '../api/chat.schemas'
import type { RunActivityItem } from '../stores/activeSession.store'

interface Props {
  item: DeepReadonly<RunActivityItem>
}

const props = defineProps<Props>()

const label = computed(() => {
  switch (props.item.status) {
    case 'aborted':
      return 'Run aborted'
    case 'completed':
      return 'Run completed'
    case 'failed':
      return 'Run failed'
    case 'maxIterations':
      return 'Iteration limit reached'
    case undefined:
      return props.item.reasoning.some((entry) => entry.streaming) ? 'Reasoning live' : 'Run active'
  }
  return 'Run active'
})

const tone = computed(() => {
  switch (props.item.status) {
    case 'aborted':
    case 'failed':
      return 'danger'
    case 'maxIterations':
      return 'warning'
    case 'completed':
      return 'complete'
    case undefined:
      return 'active'
  }
  return 'active'
})

const displayedUsage = computed<ChatUsage | undefined>(() => {
  if (props.item.usageTotal !== undefined) return props.item.usageTotal
  if (props.item.usageCalls.length === 0) return undefined
  return props.item.usageCalls.reduce<ChatUsage>(
    (total, usage) => ({
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    }),
    { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 },
  )
})

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))} ms`
  return `${(milliseconds / 1_000).toFixed(1)} s`
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <details class="activity" :class="`activity--${tone}`">
    <summary class="activity__summary">
      <span class="activity__signal" aria-hidden="true"></span>
      <strong>{{ label }}</strong>
      <span v-if="props.item.modelId !== undefined">{{ props.item.modelId }}</span>
      <span v-if="props.item.tools.length > 0">
        {{ props.item.tools.length }} tool{{ props.item.tools.length === 1 ? '' : 's' }}
      </span>
      <span v-if="displayedUsage !== undefined">
        {{ formatNumber(displayedUsage.inputTokens + displayedUsage.outputTokens) }} tokens
      </span>
      <span class="activity__disclosure">DETAILS</span>
    </summary>

    <div class="activity__body">
      <dl
        v-if="
          props.item.modelId !== undefined ||
          props.item.startedAt !== undefined ||
          props.item.durationMs !== undefined
        "
        class="activity__facts"
      >
        <div v-if="props.item.modelId !== undefined">
          <dt>Model</dt>
          <dd>{{ props.item.modelId }}</dd>
        </div>
        <div v-if="props.item.trigger !== undefined">
          <dt>Trigger</dt>
          <dd>{{ props.item.trigger }}</dd>
        </div>
        <div v-if="props.item.startedAt !== undefined">
          <dt>Started</dt>
          <dd :title="props.item.startedAt">{{ formatTime(props.item.startedAt) }}</dd>
        </div>
        <div v-if="props.item.durationMs !== undefined">
          <dt>Duration</dt>
          <dd>{{ formatDuration(props.item.durationMs) }}</dd>
        </div>
      </dl>

      <section v-if="props.item.retries.length > 0" class="activity__section">
        <h3>Provider retries</h3>
        <ul class="activity__events">
          <li v-for="retry in props.item.retries" :key="retry.id">
            <span>Attempt {{ retry.attempt }} · {{ formatDuration(retry.delayMs) }}</span>
            <p>{{ retry.text }}</p>
          </li>
        </ul>
      </section>

      <section v-if="props.item.contextChanges.length > 0" class="activity__section">
        <h3>Context changes</h3>
        <div
          v-for="change in props.item.contextChanges"
          :key="change.id"
          class="activity__context"
        >
          <p>
            {{ change.change }} · {{ change.replacedMessageIds.length }} messages replaced
          </p>
          <details class="activity__nested">
            <summary>Replacement context</summary>
            <pre>{{ change.text }}</pre>
          </details>
        </div>
      </section>

      <section v-if="displayedUsage !== undefined" class="activity__section">
        <h3>Token usage</h3>
        <dl class="activity__facts">
          <div>
            <dt>Input</dt>
            <dd>{{ formatNumber(displayedUsage.inputTokens) }}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{{ formatNumber(displayedUsage.outputTokens) }}</dd>
          </div>
          <div v-if="displayedUsage.cacheReadTokens !== undefined">
            <dt>Cache read</dt>
            <dd>{{ formatNumber(displayedUsage.cacheReadTokens) }}</dd>
          </div>
          <div>
            <dt>Model calls</dt>
            <dd>{{ props.item.usageCalls.length }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </details>
</template>

<style scoped lang="scss">
.activity {
  width: min(100%, 46rem);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: color-mix(in srgb, var(--nox-surface-1) 82%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.activity[open] {
  border-color: var(--nox-border-strong);
}

.activity__summary {
  display: flex;
  min-height: 2.75rem;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  cursor: pointer;
  list-style: none;
}

.activity__summary::-webkit-details-marker {
  display: none;
}

.activity__summary strong {
  color: var(--nox-text-primary);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.activity__summary > span:not(.activity__signal, .activity__disclosure) {
  color: var(--nox-text-muted);
}

.activity__signal {
  width: 0.5rem;
  height: 0.5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--nox-action-primary);
  box-shadow: 0 0 0.75rem color-mix(in srgb, var(--nox-action-primary) 60%, transparent);
}

.activity--danger .activity__signal {
  background: var(--nox-status-danger);
}

.activity--warning .activity__signal {
  background: var(--nox-status-warning);
}

.activity--complete .activity__signal {
  box-shadow: none;
}

.activity--active .activity__signal {
  animation: activity-pulse 1.4s ease-in-out infinite;
}

.activity__disclosure {
  margin-left: auto;
  color: var(--nox-text-muted);
  letter-spacing: 0.08em;
}

.activity__body {
  display: grid;
  gap: var(--nox-space-5);
  padding: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.activity__facts {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  gap: var(--nox-space-3);
}

.activity__facts div {
  min-width: 0;
}

.activity__facts dt,
.activity__facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.activity__facts dt,
.activity__section h3,
.activity__reasoning header,
.activity__responses span,
.activity__events span {
  color: var(--nox-text-muted);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.activity__facts dd {
  margin-top: var(--nox-space-1);
  color: var(--nox-text-secondary);
}

.activity__section {
  display: grid;
  gap: var(--nox-space-2);
}

.activity__section h3 {
  margin: 0;
  font-weight: 700;
}

.activity__reasoning,
.activity__tool,
.activity__events li,
.activity__context {
  padding: var(--nox-space-3);
  border-left: 2px solid var(--nox-border-strong);
  background: var(--nox-surface-input);
}

.activity__reasoning header,
.activity__tool > header {
  display: flex;
  justify-content: space-between;
  gap: var(--nox-space-3);
}

.activity__reasoning p,
.activity__responses p,
.activity__events p,
.activity__context > p {
  margin: var(--nox-space-2) 0 0;
  color: var(--nox-text-secondary);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.activity__tool {
  display: grid;
  gap: var(--nox-space-3);
}

.activity__tool > header strong {
  color: var(--nox-status-info);
  font-size: var(--nox-text-xs);
}

.activity__tool > header span {
  color: var(--nox-text-muted);
  text-transform: uppercase;
}

.activity__nested summary {
  color: var(--nox-text-muted);
  cursor: pointer;
}

.activity__nested pre {
  max-height: 14rem;
  margin: var(--nox-space-2) 0 0;
  padding: var(--nox-space-3);
  color: var(--nox-text-secondary);
  background: var(--nox-canvas);
  overflow: auto;
  white-space: pre-wrap;
}

.activity__responses,
.activity__events {
  display: grid;
  margin: 0;
  gap: var(--nox-space-2);
  padding: 0;
  list-style: none;
}

.activity__responses li {
  padding-top: var(--nox-space-2);
  border-top: 1px solid var(--nox-border-subtle);
}

.activity__response--error span,
.activity__response--error p {
  color: var(--nox-status-danger);
}

.activity__events li {
  border-left-color: var(--nox-status-warning);
}

.activity__context > p {
  margin-top: 0;
}

.activity__cursor {
  display: inline-block;
  width: 0.45rem;
  height: 0.9em;
  margin-left: var(--nox-space-1);
  background: var(--nox-status-info);
  vertical-align: -0.1em;
  animation: activity-blink 1s steps(2, jump-none) infinite;
}

@keyframes activity-pulse {
  50% {
    opacity: 0.35;
  }
}

@keyframes activity-blink {
  50% {
    opacity: 0;
  }
}

@media (max-width: 36rem) {
  .activity__summary > span:not(.activity__signal, .activity__disclosure) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .activity--active .activity__signal,
  .activity__cursor {
    animation: none;
  }
}
</style>
