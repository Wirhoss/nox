<script setup lang="ts">
interface Props {
  compact?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
})
</script>

<template>
  <div class="mark" :class="{ 'mark--compact': props.compact }" aria-label="Nox">
    <span class="mark__glyph" aria-hidden="true">N</span>
    <span v-if="!props.compact" class="mark__word">NOX</span>
  </div>
</template>

<style scoped lang="scss">
.mark {
  display: inline-flex;
  align-items: center;
  gap: var(--nox-space-3);
  color: var(--nox-text-primary);
  font-family: var(--nox-font-mono);
  font-weight: 800;
  letter-spacing: 0.16em;
}

.mark__glyph {
  display: grid;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--nox-action-primary);
  color: var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  font-size: var(--nox-text-sm);
  place-items: center;
  transform: skewX(-6deg);
}

.mark--compact .mark__glyph {
  width: 1.75rem;
  height: 1.75rem;
}

.mark__word {
  font-size: var(--nox-text-sm);
}
</style>
