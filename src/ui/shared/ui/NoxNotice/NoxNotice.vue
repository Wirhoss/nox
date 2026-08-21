<script setup lang="ts">
type NoticeTone = 'danger' | 'info' | 'warning'

interface Props {
  title: string
  tone?: NoticeTone
}

const props = withDefaults(defineProps<Props>(), {
  tone: 'info',
})
</script>

<template>
  <div class="notice" :class="`notice--${props.tone}`" role="alert">
    <span class="notice__marker" aria-hidden="true">!</span>
    <div>
      <strong class="notice__title">{{ props.title }}</strong>
      <div class="notice__body"><slot /></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.notice {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--nox-space-3);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-2);
  font-size: var(--nox-text-sm);
}

.notice__marker {
  display: grid;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid currentcolor;
  border-radius: 50%;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 800;
  place-items: center;
}

.notice__title {
  display: block;
  margin-bottom: var(--nox-space-1);
  color: var(--nox-text-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.notice__body :deep(p) {
  margin: 0;
}

.notice--danger .notice__marker {
  color: var(--nox-status-danger);
}

.notice--warning .notice__marker {
  color: var(--nox-status-warning);
}

.notice--info .notice__marker {
  color: var(--nox-status-info);
}
</style>
