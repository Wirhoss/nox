<script setup lang="ts">
type ButtonVariant = 'ghost' | 'primary' | 'secondary'

interface Props {
  block?: boolean
  busy?: boolean
  disabled?: boolean
  type?: 'button' | 'reset' | 'submit'
  variant?: ButtonVariant
}

const props = withDefaults(defineProps<Props>(), {
  block: false,
  busy: false,
  disabled: false,
  type: 'button',
  variant: 'primary',
})
</script>

<template>
  <button
    class="button"
    :class="[`button--${props.variant}`, { 'button--block': props.block }]"
    :type="props.type"
    :disabled="props.disabled || props.busy"
    :aria-busy="props.busy"
  >
    <span v-if="props.busy" class="button__activity" aria-hidden="true"></span>
    <span class="button__label"><slot /></span>
  </button>
</template>

<style scoped lang="scss">
.button {
  display: inline-flex;
  min-height: var(--nox-control-height);
  align-items: center;
  justify-content: center;
  gap: var(--nox-space-3);
  padding: 0 var(--nox-space-5);
  border: 1px solid transparent;
  border-radius: var(--nox-radius-control);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  cursor: pointer;
  transition:
    color var(--nox-motion-fast) var(--nox-ease-out),
    background var(--nox-motion-fast) var(--nox-ease-out),
    border-color var(--nox-motion-fast) var(--nox-ease-out),
    transform var(--nox-motion-fast) var(--nox-ease-out);

  &:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  &:active:not(:disabled) {
    transform: translateY(0);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}

.button--primary {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);

  &:hover:not(:disabled) {
    background: var(--nox-action-primary-hover);
  }
}

.button--secondary {
  color: var(--nox-text-primary);
  background: var(--nox-action-muted);
  border-color: var(--nox-border-strong);

  &:hover:not(:disabled) {
    background: var(--nox-surface-hover);
    border-color: var(--nox-action-primary);
  }
}

.button--ghost {
  min-height: auto;
  padding: var(--nox-space-2);
  color: var(--nox-text-secondary);
  background: transparent;

  &:hover:not(:disabled) {
    color: var(--nox-text-primary);
    background: var(--nox-surface-hover);
  }
}

.button--block {
  width: 100%;
}

.button__activity {
  width: 0.75rem;
  height: 0.75rem;
  border: 1px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: rotate 700ms linear infinite;
}

@keyframes rotate {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .button__activity {
    animation: none;
    border-right-color: currentcolor;
  }
}
</style>
