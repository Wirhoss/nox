<script setup lang="ts">
interface Props {
  compact?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
})
</script>

<template>
  <div
    class="mark"
    :class="{ 'mark--compact': props.compact }"
    role="img"
    aria-label="Nox"
  >
    <svg class="mark__logo" aria-hidden="true" viewBox="0 0 275.82 132.8">
      <path
        d="M36 2H2v34M239.8 2h34v34M2 96.8v34h34M273.8 96.8v34h-34"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
      />
      <circle cx="254.32" cy="21.5" r="5.5" fill="#ff4a2b" />
      <g fill="currentColor">
        <path
          d="M30 30h12.688l32.448 49.4h.208V30h13.624v72.8H76.28L43.832 53.504h-.208V102.8H30Z"
        />
        <path
          d="M106.448 90.84V41.96L118.408 30h37.44l11.96 11.96v48.88l-11.96 11.96h-37.44Zm41.912-.104 5.304-5.304V47.368l-5.304-5.304h-22.464l-5.304 5.304v38.064l5.304 5.304Z"
        />
        <path
          d="M204.424 65.256 180.088 30H196l16.432 23.92L228.864 30h15.912L220.44 65.672l25.376 37.128h-15.912l-17.472-25.688L194.96 102.8h-15.912Z"
        />
      </g>
    </svg>
  </div>
</template>

<style scoped lang="scss">
.mark {
  display: inline-flex;
  width: 7.5rem;
  max-width: 100%;
  color: var(--nox-text-primary);
  line-height: 0;
}

.mark--compact {
  width: 3rem;
}

.mark__logo {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
</style>
