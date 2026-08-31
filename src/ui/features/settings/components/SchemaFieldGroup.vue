<script setup lang="ts">
import { useI18n } from '@/shared/i18n'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { modelCatalogProblem, modelOptions, providerOptions } from '../model/catalogs'
import { NEW_SECRET } from '../model/managedSecrets'
import { isObject, listEntryDefaults, listEntryNodes, mapEntryDefaults, mapEntryNodes, valueAt, withoutKey, withRenamedKey } from '../model/schemaForm'
import CatalogField from './CatalogField.vue'

import type { ProviderInventory } from '../api/settings.api'
import type { CatalogOption } from '../model/catalogs'
import type { ConfigLike, FieldNode, FieldOption, FormNode, ListNode, MapNode, VariantNode } from '../model/schemaForm'

/**
 * What this component needs of a secret, which is its name and whether anything
 * was ever stored for it. Narrower than the store's row on purpose: the store
 * hands out a deeply readonly view, and a prop typed as the whole row would
 * refuse it for reasons that have nothing to do with this form.
 */
interface SecretRow {
  readonly secretId: string
  readonly stored: boolean
}

/** One credential input, which lives beside the entry rather than inside it. */
interface CredentialState {
  newId: string
  selection: string
  value: string
}

interface Props {
  credentials: Record<string, CredentialState>
  errors: Readonly<Record<string, string>>
  /** Namespace of the extension whose schema this is; its labels live there. */
  extensionId: string
  nodes: readonly FormNode[]
  /** What every configured provider serves, for the fields that name one. */
  providerInventory?: readonly ProviderInventory[]
  /**
   * The provider this form is editing, where the form *is* one. A model field
   * with no sibling `provider` — a provider's own `defaultModel`, an entry of
   * its `modelConfigs` — belongs to the entry being edited, and nothing in the
   * schema can say which entry that is.
   */
  providerId?: string
  secrets: readonly SecretRow[]
  value: ConfigLike
}

const props = withDefaults(defineProps<Props>(), {
  providerInventory: () => [],
  providerId: undefined,
})
const emit = defineEmits<{
  credential: [path: readonly string[], state: Partial<CredentialState>]
  update: [path: readonly string[], value: unknown]
}>()
const { hasMessage, t } = useI18n()

function key(path: readonly string[]): string {
  return path.join('.')
}

/**
 * A label the extension supplied, translated in its own namespace, or the
 * property's own name. A schema that says nothing still renders something an
 * operator can read, which is what keeps a new module usable before anyone has
 * written copy for it.
 */
function label(node: FieldNode | VariantNode | { label?: string; name: string }): string {
  const message = node.label === undefined ? undefined : `${props.extensionId}.${node.label}`
  if (message !== undefined && hasMessage(message)) return t(message)
  return humanize(node.name)
}

function optionLabel(option: FieldOption): string {
  const message =
    option.messageKey === undefined
      ? undefined
      : `${props.extensionId}.${option.messageKey}`
  if (message !== undefined && hasMessage(message)) return t(message)
  return option.label
}

function help(node: { description?: string; help?: string }): string | undefined {
  const message = node.help === undefined ? undefined : `${props.extensionId}.${node.help}`
  if (message !== undefined && hasMessage(message)) return t(message)
  return node.description
}

function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[._-]+/gu, ' ')
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

function fieldId(path: readonly string[]): string {
  return `schema-field-${key(path).replace(/\./gu, '-')}`
}

function error(path: readonly string[]): string | undefined {
  return props.errors[key(path)]
}

function text(node: FieldNode): string {
  const current = valueAt(props.value, node.path)
  return typeof current === 'string' ? current : ''
}

function numberText(node: FieldNode): string {
  const current = valueAt(props.value, node.path)
  return typeof current === 'number' ? String(current) : ''
}

function listText(node: FieldNode): string {
  const current = valueAt(props.value, node.path)
  return Array.isArray(current) ? current.map((item) => String(item)).join(', ') : ''
}

function checklistValues(node: FieldNode): readonly string[] {
  const current = valueAt(props.value, node.path)
  return Array.isArray(current) ? current.map((item) => String(item)) : []
}

function checklistChecked(node: FieldNode, option: FieldOption): boolean {
  return checklistValues(node).includes(String(option.value))
}

function checklistError(node: FieldNode): string | undefined {
  if (node.minItems !== undefined && checklistValues(node).length < node.minItems) {
    return t('settings.schemaMap.minItems', { count: node.minItems })
  }
  return error(node.path)
}

function checked(node: FieldNode): boolean {
  return valueAt(props.value, node.path) === true
}

function selected(node: FieldNode): string {
  const current = valueAt(props.value, node.path)
  if (typeof current === 'string') return current
  if (typeof current === 'number' || typeof current === 'boolean') return String(current)
  return ''
}

function setText(node: FieldNode, next: string): void {
  emit('update', node.path, next.length === 0 && !node.required ? undefined : next)
}

function setNumber(node: FieldNode, next: string): void {
  const trimmed = next.trim()
  if (trimmed.length === 0) {
    emit('update', node.path, undefined)
    return
  }
  const parsed = Number(trimmed)
  emit('update', node.path, Number.isFinite(parsed) ? parsed : trimmed)
}

function setList(node: FieldNode, next: string): void {
  const items = next
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  emit('update', node.path, items.length === 0 ? undefined : items)
}

function toggleChecklist(node: FieldNode, option: FieldOption, on: boolean): void {
  const selectedValues = new Set(checklistValues(node))
  if (on) selectedValues.add(String(option.value))
  else selectedValues.delete(String(option.value))

  // Schema order keeps persisted values stable regardless of the operator's click order.
  const next = node.options
    .filter((candidate) => selectedValues.has(String(candidate.value)))
    .map((candidate) => candidate.value)
  emit('update', node.path, next.length === 0 && !node.required ? undefined : next)
}

function setBoolean(node: FieldNode, next: boolean): void {
  emit('update', node.path, next)
}

function setOption(node: FieldNode, next: string): void {
  if (next.length === 0) {
    emit('update', node.path, undefined)
    return
  }
  const option = node.options.find((candidate) => String(candidate.value) === next)
  emit('update', node.path, option?.value ?? next)
}

/** Every stored ID, plus whatever this position already names. */
function credentialOptions(node: FieldNode): readonly string[] {
  const ids = props.secrets.map((secret) => secret.secretId)
  const current = secretId(node)
  return current.length > 0 && !ids.includes(current) ? [current, ...ids] : ids
}

function secretId(node: FieldNode): string {
  const current = valueAt(props.value, node.path)
  if (!isObject(current)) return ''
  return typeof current.$secret === 'string' ? current.$secret : ''
}

function credential(node: FieldNode): CredentialState {
  return props.credentials[key(node.path)] ?? { newId: '', selection: secretId(node), value: '' }
}

/** Whether a value exists, not whether the ID is known: configuration may name an empty one. */
function secretStored(node: FieldNode): boolean {
  const id = secretId(node)
  return props.secrets.some((secret) => secret.secretId === id && secret.stored)
}

function selectCredential(node: FieldNode, next: string): void {
  emit('credential', node.path, { newId: '', selection: next, value: '' })
  emit(
    'update',
    node.path,
    next.length === 0 || next === NEW_SECRET ? undefined : { $secret: next },
  )
}

function setNewSecretId(node: FieldNode, next: string): void {
  emit('credential', node.path, { newId: next })
  const id = next.trim()
  emit('update', node.path, id.length === 0 ? undefined : { $secret: id })
}

function setSecretValue(node: FieldNode, next: string): void {
  emit('credential', node.path, { value: next })
}

/**
 * Which provider a model field is about: the one named beside it where the
 * schema puts the two together, and otherwise the entry being edited. Both
 * cases are real — a memory names a provider and a model side by side, while a
 * provider's own model list is implicitly about itself — and neither can be
 * derived from the other.
 */
function providerFor(node: FieldNode): string | undefined {
  const sibling = valueAt(props.value, [...node.path.slice(0, -1), 'provider'])
  return typeof sibling === 'string' && sibling.length > 0 ? sibling : props.providerId
}

function catalogOptions(node: FieldNode): readonly CatalogOption[] {
  if (node.catalog === 'provider') return providerOptions(props.providerInventory, t)
  return modelOptions(props.providerInventory, providerFor(node), t)
}

/** Why a catalog has nothing to offer, so an empty list is never a silent one. */
function catalogProblem(node: FieldNode): string | undefined {
  if (node.catalog === 'provider') {
    return props.providerInventory.length === 0
      ? t('settings.catalog.noProviders')
      : undefined
  }
  return modelCatalogProblem(props.providerInventory, providerFor(node), t)
}

function chosenVariant(node: VariantNode): string {
  const current = valueAt(props.value, node.path)
  if (!isObject(current)) return ''
  const chosen = current[node.discriminator]
  return typeof chosen === 'string' ? chosen : ''
}

function variantChildren(node: VariantNode): readonly FormNode[] {
  const chosen = chosenVariant(node)
  return node.variants.find((variant) => variant.value === chosen)?.children ?? []
}

/**
 * The record a map node edits. Absent reads as empty rather than as an error: a
 * map with a default of `{}` is not written until something is put in it.
 */
function mapRecord(node: MapNode): ConfigLike {
  const current = valueAt(props.value, node.path)
  return isObject(current) ? current : {}
}

/**
 * The keys on screen, in the order the record holds them.
 *
 * Rows are keyed by position rather than by the key itself, because renaming is
 * what typing a key *is* — keying by it would tear down and rebuild the input on
 * every character and take the caret with it.
 */
function mapKeys(node: MapNode): readonly string[] {
  return Object.keys(mapRecord(node))
}

/**
 * Whether a key is one this map will accept, per its `propertyNames`.
 *
 * A pattern that will not compile is treated as no pattern rather than thrown:
 * it comes from an extension's schema, and one bad regex should cost that field
 * its client-side check — the server still refuses the key — not the whole form.
 */
function mapKeyError(node: MapNode, entryKey: string): string | undefined {
  if (entryKey.length === 0) return t('settings.schemaMap.keyRequired')
  if (node.keyPattern === undefined) return undefined

  let pattern: RegExp
  try {
    pattern = new RegExp(node.keyPattern, 'u')
  } catch {
    return undefined
  }
  return pattern.test(entryKey) ? undefined : t('settings.schemaMap.keyInvalid')
}

/**
 * Adds an entry with no key yet, which the operator then names. Refused while
 * one is already unnamed: a second blank key would land on the first.
 */
function addMapEntry(node: MapNode): void {
  const record = mapRecord(node)
  if (Object.keys(record).includes('')) return
  emit('update', node.path, { ...record, '': mapEntryDefaults(node) })
}

function removeMapEntry(node: MapNode, entryKey: string): void {
  emit('update', node.path, withoutKey(mapRecord(node), entryKey))
}

function renameMapEntry(node: MapNode, from: string, to: string): void {
  emit('update', node.path, withRenamedKey(mapRecord(node), from, to.trim()))
}

function mapEntryLabel(entryKey: string): string {
  return entryKey.length === 0 ? t('settings.schemaMap.unnamedEntry') : entryKey
}

function listItems(node: ListNode): readonly unknown[] {
  const current = valueAt(props.value, node.path)
  return Array.isArray(current) ? current : []
}

function addListEntry(node: ListNode): void {
  emit('update', node.path, [...listItems(node), listEntryDefaults(node)])
}

function removeListEntry(node: ListNode, index: number): void {
  const remaining = listItems(node).filter((_item, at) => at !== index)
  // Emptied back to absent rather than to `[]`, matching how a cleared list of
  // scalars behaves: an absent optional array is what the schema defaults from.
  emit('update', node.path, remaining.length === 0 && node.optional ? undefined : remaining)
}

</script>

<template>
  <div class="schema-fields">
    <template v-for="node in props.nodes" :key="key(node.path)">
      <div
        v-if="node.kind === 'field' && node.control === 'secret'"
        class="schema-fields__secret"
      >
        <div
          class="schema-fields__field"
          :class="{ 'schema-fields__field--invalid': error(node.path) }"
        >
          <label :for="fieldId(node.path)">{{ label(node) }}</label>
          <select
            :id="fieldId(node.path)"
            :value="credential(node).selection"
            @change="selectCredential(node, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.toolSet.noCredential') }}</option>
            <option v-for="secretId in credentialOptions(node)" :key="secretId" :value="secretId">
              {{ secretId }}
            </option>
            <option :value="NEW_SECRET">+ {{ t('settings.toolSet.newManagedSecret') }}</option>
          </select>
          <p v-if="help(node)" class="schema-fields__hint">{{ help(node) }}</p>
          <p v-if="error(node.path)" class="schema-fields__error">{{ error(node.path) }}</p>
        </div>

        <div
          v-if="credential(node).selection && credential(node).selection !== NEW_SECRET"
          class="schema-fields__secret-status"
        >
          <span>{{ credential(node).selection }}</span>
          <strong :class="{ 'schema-fields__secret-missing': !secretStored(node) }">
            {{
              secretStored(node)
                ? t('settings.secrets.stored')
                : t('common.missing').toUpperCase()
            }}
          </strong>
        </div>

        <NoxTextField
          v-if="credential(node).selection === NEW_SECRET"
          :id="`${fieldId(node.path)}-id`"
          :model-value="credential(node).newId"
          :error="error([...node.path, 'secretId'])"
          :hint="t('settings.toolSet.secretIdHint')"
          :label="t('settings.toolSet.newSecretId')"
          placeholder="SECRET_ID"
          required
          @update:model-value="setNewSecretId(node, $event)"
        />
        <NoxTextField
          v-if="credential(node).selection"
          :id="`${fieldId(node.path)}-value`"
          :model-value="credential(node).value"
          autocomplete="new-password"
          :error="error([...node.path, 'secretValue'])"
          :hint="t('settings.toolSet.credentialValueHint')"
          :label="t('settings.toolSet.credentialValue')"
          :placeholder="t('settings.toolSet.credentialValue')"
          :required="credential(node).selection === NEW_SECRET"
          type="password"
          @update:model-value="setSecretValue(node, $event)"
        />
      </div>

      <div
        v-else-if="node.kind === 'field' && node.control === 'enum'"
        class="schema-fields__field"
        :class="{ 'schema-fields__field--invalid': error(node.path) }"
      >
        <label :for="fieldId(node.path)">
          {{ label(node) }}
          <small v-if="node.required">{{ t('common.requiredShort') }}</small>
        </label>
        <select
          :id="fieldId(node.path)"
          :value="selected(node)"
          @change="setOption(node, ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!node.required" value="">—</option>
          <option
            v-for="option in node.options"
            :key="String(option.value)"
            :value="String(option.value)"
          >
            {{ optionLabel(option) }}
          </option>
        </select>
        <p v-if="help(node)" class="schema-fields__hint">{{ help(node) }}</p>
        <p v-if="error(node.path)" class="schema-fields__error">{{ error(node.path) }}</p>
      </div>

      <label
        v-else-if="node.kind === 'field' && node.control === 'boolean'"
        class="schema-fields__switch"
      >
        <input
          type="checkbox"
          :checked="checked(node)"
          @change="setBoolean(node, ($event.target as HTMLInputElement).checked)"
        />
        <span>
          <strong>{{ label(node) }}</strong>
          <small v-if="help(node)">{{ help(node) }}</small>
        </span>
      </label>

      <NoxTextField
        v-else-if="node.kind === 'field' && node.control === 'number'"
        :id="fieldId(node.path)"
        :model-value="numberText(node)"
        :error="error(node.path)"
        :hint="help(node)"
        :label="label(node)"
        :required="node.required"
        @update:model-value="setNumber(node, $event)"
      />

      <fieldset
        v-else-if="node.kind === 'field' && node.control === 'checklist'"
        class="schema-fields__checklist"
        :class="{ 'schema-fields__checklist--invalid': checklistError(node) }"
      >
        <legend>
          {{ label(node) }}
          <small v-if="node.required">{{ t('common.requiredShort') }}</small>
        </legend>
        <div class="schema-fields__checklist-options">
          <label
            v-for="option in node.options"
            :key="String(option.value)"
            class="schema-fields__checklist-option"
          >
            <input
              type="checkbox"
              :checked="checklistChecked(node, option)"
              @change="
                toggleChecklist(node, option, ($event.target as HTMLInputElement).checked)
              "
            />
            <span>{{ optionLabel(option) }}</span>
          </label>
        </div>
        <p v-if="help(node)" class="schema-fields__hint">{{ help(node) }}</p>
        <p v-if="checklistError(node)" class="schema-fields__error">
          {{ checklistError(node) }}
        </p>
      </fieldset>

      <NoxTextField
        v-else-if="node.kind === 'field' && node.control === 'list'"
        :id="fieldId(node.path)"
        :model-value="listText(node)"
        :error="error(node.path)"
        :hint="help(node) ?? t('settings.toolSet.listHint')"
        :label="label(node)"
        :required="node.required"
        @update:model-value="setList(node, $event)"
      />

      <CatalogField
        v-else-if="node.kind === 'field' && node.catalog !== undefined"
        :id="fieldId(node.path)"
        :model-value="text(node)"
        :error="error(node.path)"
        :hint="help(node)"
        :label="label(node)"
        :options="catalogOptions(node)"
        :problem="catalogProblem(node)"
        :required="node.required"
        @update:model-value="setText(node, $event)"
      />

      <NoxTextField
        v-else-if="node.kind === 'field'"
        :id="fieldId(node.path)"
        :model-value="text(node)"
        :error="error(node.path)"
        :hint="help(node)"
        :label="label(node)"
        :placeholder="node.url ? 'https://service.example' : undefined"
        :required="node.required"
        @update:model-value="setText(node, $event)"
      />

      <div v-else-if="node.kind === 'variant'" class="schema-fields__nested">
        <div class="schema-fields__field">
          <label :for="fieldId(node.path)">
            {{ label(node) }} <small>{{ t('common.requiredShort') }}</small>
          </label>
          <select
            :id="fieldId(node.path)"
            :value="chosenVariant(node)"
            @change="
              emit('update', [...node.path, node.discriminator], ($event.target as HTMLSelectElement).value)
            "
          >
            <option v-for="variant in node.variants" :key="variant.value" :value="variant.value">
              {{ variant.value }}
            </option>
          </select>
        </div>
        <SchemaFieldGroup
          :credentials="props.credentials"
          :errors="props.errors"
          :extension-id="props.extensionId"
          :provider-inventory="props.providerInventory"
          :provider-id="props.providerId"
          :nodes="variantChildren(node)"
          :secrets="props.secrets"
          :value="props.value"
          @credential="(path, state) => emit('credential', path, state)"
          @update="(path, next) => emit('update', path, next)"
        />
      </div>

      <div v-else-if="node.kind === 'list'" class="schema-fields__nested">
        <div class="schema-fields__map-head">
          <p class="schema-fields__nested-title">{{ label(node) }}</p>
          <button type="button" class="schema-fields__map-add" @click="addListEntry(node)">
            + {{ t('common.add') }}
          </button>
        </div>
        <p v-if="help(node)" class="schema-fields__hint">{{ help(node) }}</p>

        <div
          v-for="(_item, index) in listItems(node)"
          :key="index"
          class="schema-fields__map-entry"
        >
          <div class="schema-fields__map-entry-head">
            <p class="schema-fields__list-position">
              {{ t('settings.schemaMap.position', { position: index + 1 }) }}
            </p>
            <button
              type="button"
              class="schema-fields__map-remove"
              :aria-label="
                t('settings.schemaMap.removeNamed', { entry: String(index + 1) })
              "
              @click="removeListEntry(node, index)"
            >
              {{ t('common.remove') }}
            </button>
          </div>
          <SchemaFieldGroup
            :credentials="props.credentials"
            :errors="props.errors"
            :extension-id="props.extensionId"
            :provider-inventory="props.providerInventory"
            :provider-id="props.providerId"
            :nodes="listEntryNodes(node, index)"
            :secrets="props.secrets"
            :value="props.value"
            @credential="(path, state) => emit('credential', path, state)"
            @update="(path, next) => emit('update', path, next)"
          />
        </div>

        <p v-if="listItems(node).length === 0" class="schema-fields__map-empty">
          {{ t('settings.schemaMap.empty') }}
        </p>
      </div>

      <div v-else-if="node.kind === 'map'" class="schema-fields__nested">
        <div class="schema-fields__map-head">
          <p class="schema-fields__nested-title">{{ label(node) }}</p>
          <button type="button" class="schema-fields__map-add" @click="addMapEntry(node)">
            + {{ t('common.add') }}
          </button>
        </div>
        <p v-if="help(node)" class="schema-fields__hint">{{ help(node) }}</p>

        <div
          v-for="(entryKey, index) in mapKeys(node)"
          :key="index"
          class="schema-fields__map-entry"
        >
          <div class="schema-fields__map-entry-head">
            <NoxTextField
              :id="`${fieldId(node.path)}-key-${index}`"
              :model-value="entryKey"
              :error="mapKeyError(node, entryKey)"
              :label="t('settings.schemaMap.key')"
              required
              @update:model-value="renameMapEntry(node, entryKey, $event)"
            />
            <button
              type="button"
              class="schema-fields__map-remove"
              :aria-label="
                t('settings.schemaMap.removeNamed', { entry: mapEntryLabel(entryKey) })
              "
              @click="removeMapEntry(node, entryKey)"
            >
              {{ t('common.remove') }}
            </button>
          </div>
          <SchemaFieldGroup
            :credentials="props.credentials"
            :errors="props.errors"
            :extension-id="props.extensionId"
            :provider-inventory="props.providerInventory"
            :provider-id="props.providerId"
            :nodes="mapEntryNodes(node, entryKey)"
            :secrets="props.secrets"
            :value="props.value"
            @credential="(path, state) => emit('credential', path, state)"
            @update="(path, next) => emit('update', path, next)"
          />
        </div>

        <p v-if="mapKeys(node).length === 0" class="schema-fields__map-empty">
          {{ t('settings.schemaMap.empty') }}
        </p>
      </div>

      <div v-else class="schema-fields__nested">
        <p class="schema-fields__nested-title">{{ label(node) }}</p>
        <SchemaFieldGroup
          :credentials="props.credentials"
          :errors="props.errors"
          :extension-id="props.extensionId"
          :provider-inventory="props.providerInventory"
          :provider-id="props.providerId"
          :nodes="node.children"
          :secrets="props.secrets"
          :value="props.value"
          @credential="(path, state) => emit('credential', path, state)"
          @update="(path, next) => emit('update', path, next)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.schema-fields {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.schema-fields__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.schema-fields__field > label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.schema-fields__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.schema-fields__field select {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.schema-fields__field select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.schema-fields__field--invalid select {
  border-color: var(--nox-status-danger);
}

.schema-fields__list-position {
  margin: 0;
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.schema-fields__hint {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}

.schema-fields__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.schema-fields__switch {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
  cursor: pointer;
}

.schema-fields__switch input {
  accent-color: var(--nox-action-primary);
}

.schema-fields__switch span {
  display: grid;
  gap: var(--nox-space-1);
}

.schema-fields__switch strong,
.schema-fields__switch small {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.schema-fields__switch small {
  color: var(--nox-text-muted);
}

.schema-fields__checklist {
  display: grid;
  gap: var(--nox-space-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.schema-fields__checklist legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.schema-fields__checklist legend small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.schema-fields__checklist-options {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.schema-fields__checklist-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--nox-space-3);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.schema-fields__checklist-option input {
  accent-color: var(--nox-action-primary);
}

.schema-fields__checklist--invalid .schema-fields__checklist-options {
  border-color: var(--nox-status-danger);
}

.schema-fields__secret {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
  background: color-mix(in srgb, var(--nox-surface-1) 80%, transparent);
}

.schema-fields__secret-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.schema-fields__secret-status span,
.schema-fields__secret-status strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.schema-fields__secret-status span {
  color: var(--nox-text-secondary);
  overflow-wrap: anywhere;
}

.schema-fields__secret-status strong {
  color: var(--nox-status-success);
}

.schema-fields__secret-status .schema-fields__secret-missing {
  color: var(--nox-status-danger);
}

.schema-fields__nested {
  display: grid;
  gap: var(--nox-space-4);
}

.schema-fields__nested-title {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.schema-fields__map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
}

.schema-fields__map-add {
  min-height: 2.25rem;
  padding: 0 var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-secondary);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.schema-fields__map-add:hover,
.schema-fields__map-remove:hover {
  border-color: var(--nox-action-primary);
  color: var(--nox-action-primary);
  background: var(--nox-surface-hover);
}

.schema-fields__map-entry {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-surface-1) 82%, transparent);
}

.schema-fields__map-entry-head {
  display: grid;
  align-items: start;
  grid-template-columns: 1fr auto;
  gap: var(--nox-space-3);
}

.schema-fields__map-remove {
  min-height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.schema-fields__map-empty {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}
</style>
