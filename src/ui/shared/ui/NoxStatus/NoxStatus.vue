<script setup lang="ts">
type StatusTone = 'danger' | 'operational' | 'waiting'

interface Props {
  label: string
  tone?: StatusTone
}

const props = withDefaults(defineProps<Props>(), {
  tone: 'operational',
})
</script>

<template>
  <span class="status" :class="`status--${props.tone}`">
    <span class="status__signal" aria-hidden="true"></span>
    <span>{{ props.label }}</span>
  </span>
</template>

<style scoped lang="scss">
.status {
  display: inline-flex;
  align-items: center;
  gap: var(--nox-space-2);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.status__signal {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: currentcolor;
  box-shadow: 0 0 12px currentcolor;
}

.status--operational {
  color: var(--nox-status-success);
}

.status--waiting {
  color: var(--nox-status-warning);

  .status__signal {
    animation: signal 1.4s ease-in-out infinite;
  }
}

.status--danger {
  color: var(--nox-status-danger);
}

@keyframes signal {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status--waiting .status__signal {
    animation: none;
  }
}
</style>
