<script setup lang="ts">
interface Props {
  labelledBy?: string
}

const props = withDefaults(defineProps<Props>(), {
  labelledBy: undefined,
})
</script>

<template>
  <section class="panel" :aria-labelledby="props.labelledBy">
    <slot />
  </section>
</template>

<style scoped lang="scss">
.panel {
  position: relative;
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-panel);
  background: color-mix(in srgb, var(--nox-surface-1) 94%, transparent);
  box-shadow: var(--nox-shadow-panel);
  overflow: hidden;
}

.panel::before {
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--nox-action-primary), transparent 45%);
  content: '';
  opacity: 0.7;
  pointer-events: none;
}
</style>
