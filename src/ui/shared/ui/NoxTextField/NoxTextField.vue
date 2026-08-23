<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from '@/shared/i18n'

defineOptions({ inheritAttrs: false })

interface Props {
  autocomplete?: string
  disabled?: boolean
  error?: string
  hint?: string
  id: string
  label: string
  modelValue: string
  name?: string
  placeholder?: string
  required?: boolean
  type?: 'email' | 'password' | 'text'
}

const { t } = useI18n()
const props = withDefaults(defineProps<Props>(), {
  autocomplete: undefined,
  disabled: false,
  error: undefined,
  hint: undefined,
  name: undefined,
  placeholder: undefined,
  required: false,
  type: 'text',
})

const emit = defineEmits<{
  blur: [event: FocusEvent]
  'update:modelValue': [value: string]
}>()

const errorId = computed(() => `${props.id}-error`)
const hintId = computed(() => `${props.id}-hint`)
const describedBy = computed(() => {
  const ids: string[] = []
  if (props.hint !== undefined) ids.push(hintId.value)
  if (props.error !== undefined) ids.push(errorId.value)
  return ids.length > 0 ? ids.join(' ') : undefined
})

function onInput(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  emit('update:modelValue', event.target.value)
}
</script>

<template>
  <div class="field" :class="{ 'field--invalid': props.error !== undefined }">
    <label class="field__label" :for="props.id">
      <span>{{ props.label }}</span>
      <span v-if="props.required" class="field__required" aria-hidden="true">{{
        t('common.requiredShort')
      }}</span>
    </label>

    <input
      v-bind="$attrs"
      :id="props.id"
      class="field__control"
      :name="props.name"
      :type="props.type"
      :value="props.modelValue"
      :autocomplete="props.autocomplete"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :required="props.required"
      :aria-describedby="describedBy"
      :aria-invalid="props.error !== undefined"
      @blur="emit('blur', $event)"
      @input="onInput"
    />

    <p v-if="props.hint !== undefined" :id="hintId" class="field__hint">{{ props.hint }}</p>
    <p v-if="props.error !== undefined" :id="errorId" class="field__error" role="alert">
      {{ props.error }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.field__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.field__required {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.field__control {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
  caret-color: var(--nox-action-primary);
  transition:
    background var(--nox-motion-fast) var(--nox-ease-out),
    border-color var(--nox-motion-fast) var(--nox-ease-out),
    box-shadow var(--nox-motion-fast) var(--nox-ease-out);

  &::placeholder {
    color: var(--nox-text-muted);
  }

  &:hover:not(:disabled) {
    border-color: var(--nox-border-strong);
  }

  &:focus {
    border-color: var(--nox-action-primary);
    outline: none;
    box-shadow: 0 0 0 1px var(--nox-action-primary);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}

.field--invalid .field__control {
  border-color: var(--nox-status-danger);
}

.field__hint,
.field__error {
  margin: 0;
  font-size: var(--nox-text-xs);
  line-height: 1.5;
}

.field__hint {
  color: var(--nox-text-muted);
}

.field__error {
  color: var(--nox-status-danger);
}
</style>
