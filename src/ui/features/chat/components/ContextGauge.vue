<script setup lang="ts">
import { computed } from 'vue'

import type { ChatContextUsage } from '../api/chat.schemas'

interface Props {
  usage?: ChatContextUsage
}

const props = defineProps<Props>()

const ratio = computed<number | undefined>(() => {
  const usage = props.usage
  if (usage?.contextWindow === undefined) return undefined
  return Math.min(1, usage.usedTokens / usage.contextWindow)
})
const percentage = computed(() =>
  ratio.value === undefined ? undefined : Math.round(ratio.value * 100),
)
const tokenLabel = computed(() => {
  const usage = props.usage
  if (usage === undefined) return '—'
  if (usage.contextWindow === undefined) return `${formatNumber(usage.usedTokens)} tokens`
  return `${formatNumber(usage.usedTokens)} / ${formatNumber(usage.contextWindow)}`
})
const compactRatio = computed(() => {
  const usage = props.usage
  if (usage?.contextWindow === undefined || usage.compactAtTokens === undefined) return 0.8
  return Math.min(1, usage.compactAtTokens / usage.contextWindow)
})
const tone = computed(() => {
  const value = ratio.value
  if (value === undefined) return 'unknown'
  if (value >= 0.9) return 'danger'
  if (value >= compactRatio.value) return 'warning'
  return 'normal'
})
const label = computed(() => {
  const usage = props.usage
  if (usage === undefined) return 'Context usage is not available yet'
  if (usage.contextWindow === undefined) {
    return `Context uses approximately ${formatNumber(usage.usedTokens)} tokens; model capacity is unknown`
  }
  return `Context ${String(percentage.value)} percent full: approximately ${formatNumber(usage.usedTokens)} of ${formatNumber(usage.contextWindow)} tokens`
})

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}
</script>

<template>
  <div
    class="context-gauge"
    :class="`context-gauge--${tone}`"
    role="meter"
    aria-label="Context window"
    aria-valuemin="0"
    :aria-valuemax="props.usage?.contextWindow"
    :aria-valuenow="props.usage?.usedTokens"
    :aria-valuetext="label"
    :title="label"
  >
    <svg class="context-gauge__donut" viewBox="0 0 42 42" aria-hidden="true">
      <circle class="context-gauge__track" cx="21" cy="21" r="16" />
      <circle
        v-if="ratio !== undefined"
        class="context-gauge__value"
        cx="21"
        cy="21"
        r="16"
        pathLength="100"
        :stroke-dasharray="`${String(ratio * 100)} 100`"
      />
      <circle v-else class="context-gauge__unknown" cx="21" cy="21" r="16" pathLength="100" />
    </svg>

    <span class="context-gauge__copy">
      <strong>{{ tokenLabel }}</strong>
      <span>{{ percentage === undefined ? '—' : `${String(percentage)}%` }} CTX</span>
    </span>
  </div>
</template>

<style scoped lang="scss">
.context-gauge {
  display: inline-flex;
  align-items: center;
  gap: var(--nox-space-2);
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  white-space: nowrap;
}

.context-gauge--warning {
  color: var(--nox-status-warning);
}

.context-gauge--danger {
  color: var(--nox-status-danger);
}

.context-gauge--unknown {
  color: var(--nox-text-muted);
}

.context-gauge__donut {
  width: 1.7rem;
  height: 1.7rem;
  flex: 0 0 auto;
  transform: rotate(-90deg);
}

.context-gauge__track,
.context-gauge__value,
.context-gauge__unknown {
  fill: none;
  stroke-width: 3;
}

.context-gauge__track {
  stroke: var(--nox-border-subtle);
}

.context-gauge__value {
  stroke: currentcolor;
  stroke-linecap: round;
  transition:
    stroke-dasharray var(--nox-motion-fast) var(--nox-ease-out),
    stroke var(--nox-motion-fast) var(--nox-ease-out);
}

.context-gauge__unknown {
  stroke: currentcolor;
  stroke-dasharray: 4 8;
}

.context-gauge__copy {
  display: grid;
  justify-items: start;
  line-height: 1;
}

.context-gauge__copy strong {
  color: currentcolor;
  font-size: 0.68rem;
}

.context-gauge__copy span {
  margin-top: 0.22rem;
  color: var(--nox-text-muted);
  font-size: 0.56rem;
  letter-spacing: 0.08em;
}

@media (prefers-reduced-motion: reduce) {
  .context-gauge__value {
    transition: none;
  }
}
</style>
