<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import type { CatalogOption } from '../model/catalogs'

/**
 * A name chosen from what exists, with a way out.
 *
 * Provider IDs and model IDs are both names of things that already exist
 * somewhere else — a configured entry, a model an endpoint reports — and typing
 * one from memory is how configuration ends up naming something no service
 * serves. Nothing catches that until the first run fails, so the choice is
 * offered here instead.
 *
 * The way out is deliberate and not a hedge. A provider whose endpoint has no
 * model list, one that is unreachable while its configuration is being written,
 * and a model deployed since the list was fetched are all ordinary; a field that
 * refused every unlisted value would make those installations unconfigurable.
 * So the list is the path of least resistance and free text stays available,
 * announced rather than implied.
 */
interface Props {
  disabled?: boolean
  error?: string
  hint?: string
  id: string
  label: string
  modelValue: string
  options: readonly CatalogOption[]
  /** Why there is nothing to choose from, when there is nothing. */
  problem?: string
  required?: boolean
}

/** Reserved: an option value no provider ID and no model ID would ever be. */
const CUSTOM = '__nox_custom__'

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  error: undefined,
  hint: undefined,
  problem: undefined,
  required: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t } = useI18n()

/** Whether the operator has asked to type a value the catalog does not offer. */
const typing = ref(false)

const known = computed(() => props.options.some((option) => option.value === props.modelValue))
const custom = computed(
  () => typing.value || (props.modelValue.length > 0 && !known.value),
)
const selection = computed(() => (custom.value ? CUSTOM : props.modelValue))

// A value that becomes offered — the endpoint answered, or another field
// changed which provider is in scope — stops being a custom one.
watch(
  () => [props.modelValue, props.options] as const,
  () => {
    if (typing.value && known.value) typing.value = false
  },
)

function select(next: string): void {
  if (next === CUSTOM) {
    typing.value = true
    return
  }
  typing.value = false
  emit('update:modelValue', next)
}

function optionLabel(option: CatalogOption): string {
  return option.note === undefined ? option.value : `${option.value} · ${option.note}`
}
</script>

<template>
  <div v-if="props.options.length === 0" class="catalog-field">
    <NoxTextField
      :id="props.id"
      :model-value="props.modelValue"
      :disabled="props.disabled"
      :error="props.error"
      :hint="props.hint"
      :label="props.label"
      :required="props.required"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <p v-if="props.problem !== undefined" class="catalog-field__note">{{ props.problem }}</p>
  </div>

  <div
    v-else
    class="catalog-field"
    :class="{ 'catalog-field--invalid': props.error !== undefined }"
  >
    <label class="catalog-field__label" :for="props.id">
      <span>{{ props.label }}</span>
      <span v-if="props.required" class="catalog-field__required" aria-hidden="true">
        {{ t('common.requiredShort') }}
      </span>
    </label>
    <select
      :id="props.id"
      class="catalog-field__control"
      :disabled="props.disabled"
      :value="selection"
      :aria-invalid="props.error !== undefined"
      @change="select(($event.target as HTMLSelectElement).value)"
    >
      <option v-if="!props.required || props.modelValue.length === 0" value="">—</option>
      <option v-for="option in props.options" :key="option.value" :value="option.value">
        {{ optionLabel(option) }}
      </option>
      <option :value="CUSTOM">{{ t('settings.catalog.custom') }}</option>
    </select>

    <NoxTextField
      v-if="custom"
      :id="`${props.id}-custom`"
      :model-value="props.modelValue"
      :disabled="props.disabled"
      :hint="t('settings.catalog.customHint')"
      :label="t('settings.catalog.customValue')"
      :required="props.required"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <p v-if="props.hint !== undefined" class="catalog-field__note">{{ props.hint }}</p>
    <p v-if="props.error !== undefined" class="catalog-field__error" role="alert">
      {{ props.error }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.catalog-field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.catalog-field__label {
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

.catalog-field__required {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.catalog-field__control {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);

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

.catalog-field--invalid .catalog-field__control {
  border-color: var(--nox-status-danger);
}

.catalog-field__note,
.catalog-field__error {
  margin: 0;
  font-size: var(--nox-text-xs);
  line-height: 1.5;
}

.catalog-field__note {
  color: var(--nox-text-muted);
}

.catalog-field__error {
  color: var(--nox-status-danger);
}
</style>
