<script setup lang="ts">
import { useI18n } from '@/shared/i18n'

import {
  type CommandField,
  defaultFor,
  fieldsOf,
  isObject,
  itemSchema,
  type JsonObject,
  type JsonSchema,
  optionsOf,
  parseInput,
  typeOf,
} from '../model/commandForm'

interface Props {
  idPrefix: string
  schema: JsonSchema
  value: Readonly<JsonObject>
}

const props = defineProps<Props>()
const emit = defineEmits<{ update: [value: JsonObject] }>()
const { t } = useI18n()

function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[._-]+/gu, ' ')
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

function fieldId(name: string): string {
  return `${props.idPrefix}-${name.replace(/[^a-z0-9_-]/giu, '-')}`
}

function present(field: CommandField): boolean {
  return Object.keys(props.value).includes(field.name)
}

function current(field: CommandField): unknown {
  return props.value[field.name]
}

function updateField(field: CommandField, value: unknown): void {
  if (value === undefined) {
    emit(
      'update',
      Object.fromEntries(Object.entries(props.value).filter(([name]) => name !== field.name)),
    )
    return
  }
  emit('update', { ...props.value, [field.name]: value })
}

function toggle(field: CommandField, enabled: boolean): void {
  updateField(field, enabled ? defaultFor(field.schema) : undefined)
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function optionIndex(schema: JsonSchema, value: unknown): string {
  const index = optionsOf(schema).findIndex((option) => Object.is(option, value))
  return index < 0 ? '' : String(index)
}

function chooseOption(field: CommandField, index: string): void {
  const chosen = optionsOf(field.schema)[Number(index)]
  updateField(field, chosen)
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function objectValue(value: unknown): Readonly<JsonObject> {
  return isObject(value) ? value : {}
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function addItem(field: CommandField): void {
  updateField(field, [...arrayValue(current(field)), defaultFor(itemSchema(field.schema))])
}

function updateItem(field: CommandField, index: number, value: unknown): void {
  const items = [...arrayValue(current(field))]
  items[index] = value
  updateField(field, items)
}

function removeItem(field: CommandField, index: number): void {
  updateField(
    field,
    arrayValue(current(field)).filter((_, candidate) => candidate !== index),
  )
}

function itemOptionIndex(schema: JsonSchema, value: unknown): string {
  return optionIndex(itemSchema(schema), value)
}

function chooseItemOption(field: CommandField, index: number, option: string): void {
  updateItem(field, index, optionsOf(itemSchema(field.schema))[Number(option)])
}
</script>

<template>
  <div class="command-fields">
    <section v-for="field in fieldsOf(props.schema)" :key="field.name" class="command-fields__field">
      <label v-if="!field.required" class="command-fields__optional">
        <input
          type="checkbox"
          :checked="present(field)"
          @change="toggle(field, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t('chat.command.useField', { field: humanize(field.name) }) }}</span>
      </label>

      <template v-if="field.required || present(field)">
        <label class="command-fields__label" :for="fieldId(field.name)">
          <span>{{ humanize(field.name) }}</span>
          <small v-if="field.required">{{ t('common.requiredShort') }}</small>
        </label>

        <select
          v-if="optionsOf(field.schema).length > 0"
          :id="fieldId(field.name)"
          :value="optionIndex(field.schema, current(field))"
          @change="chooseOption(field, ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="(option, index) in optionsOf(field.schema)"
            :key="index"
            :value="String(index)"
          >
            {{ String(option) }}
          </option>
        </select>

        <label v-else-if="typeOf(field.schema) === 'boolean'" class="command-fields__boolean">
          <input
            type="checkbox"
            :checked="booleanValue(current(field))"
            @change="updateField(field, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ booleanValue(current(field)) ? 'True' : 'False' }}</span>
        </label>

        <CommandSchemaFields
          v-else-if="typeOf(field.schema) === 'object'"
          :id-prefix="fieldId(field.name)"
          :schema="field.schema"
          :value="objectValue(current(field))"
          @update="updateField(field, $event)"
        />

        <div v-else-if="typeOf(field.schema) === 'array'" class="command-fields__array">
          <div
            v-for="(item, index) in arrayValue(current(field))"
            :key="index"
            class="command-fields__array-item"
          >
            <CommandSchemaFields
              v-if="typeOf(itemSchema(field.schema)) === 'object'"
              :id-prefix="`${fieldId(field.name)}-${String(index)}`"
              :schema="itemSchema(field.schema)"
              :value="objectValue(item)"
              @update="updateItem(field, index, $event)"
            />
            <select
              v-else-if="optionsOf(itemSchema(field.schema)).length > 0"
              :aria-label="`${humanize(field.name)} ${String(index + 1)}`"
              :value="itemOptionIndex(field.schema, item)"
              @change="
                chooseItemOption(field, index, ($event.target as HTMLSelectElement).value)
              "
            >
              <option
                v-for="(option, optionIndexValue) in optionsOf(itemSchema(field.schema))"
                :key="optionIndexValue"
                :value="String(optionIndexValue)"
              >
                {{ String(option) }}
              </option>
            </select>
            <input
              v-else
              :aria-label="`${humanize(field.name)} ${String(index + 1)}`"
              :type="
                ['integer', 'number'].includes(typeOf(itemSchema(field.schema)) ?? '')
                  ? 'number'
                  : 'text'
              "
              :value="textValue(item)"
              @input="
                updateItem(
                  field,
                  index,
                  parseInput(($event.target as HTMLInputElement).value, itemSchema(field.schema)),
                )
              "
            />
            <button type="button" @click="removeItem(field, index)">
              {{ t('common.remove') }}
            </button>
          </div>
          <button type="button" class="command-fields__add" @click="addItem(field)">
            + {{ t('chat.command.addItem') }}
          </button>
        </div>

        <input
          v-else-if="['integer', 'number'].includes(typeOf(field.schema) ?? '')"
          :id="fieldId(field.name)"
          type="number"
          :step="typeOf(field.schema) === 'integer' ? '1' : 'any'"
          :min="typeof field.schema.minimum === 'number' ? field.schema.minimum : undefined"
          :max="typeof field.schema.maximum === 'number' ? field.schema.maximum : undefined"
          :value="textValue(current(field))"
          @input="
            updateField(
              field,
              parseInput(($event.target as HTMLInputElement).value, field.schema),
            )
          "
        />

        <input
          v-else
          :id="fieldId(field.name)"
          type="text"
          :value="textValue(current(field))"
          @input="updateField(field, ($event.target as HTMLInputElement).value)"
        />

        <p v-if="typeof field.schema.description === 'string'" class="command-fields__hint">
          {{ field.schema.description }}
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
.command-fields,
.command-fields__array {
  display: grid;
  gap: var(--nox-space-3);
}

.command-fields__field {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
}

.command-fields__label,
.command-fields__optional,
.command-fields__boolean {
  display: flex;
  align-items: center;
  gap: var(--nox-space-2);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.command-fields__label {
  justify-content: space-between;
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.command-fields__label small {
  color: var(--nox-text-muted);
}

.command-fields input[type='text'],
.command-fields input[type='number'],
.command-fields select {
  width: 100%;
  min-height: var(--nox-control-height);
  padding: 0 var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.command-fields__array-item {
  display: flex;
  align-items: start;
  gap: var(--nox-space-2);
}

.command-fields__array-item > :first-child {
  flex: 1;
}

.command-fields button {
  min-height: var(--nox-control-height);
  padding: 0 var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: transparent;
  cursor: pointer;
}

.command-fields__add {
  justify-self: start;
}

.command-fields__hint {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}
</style>
