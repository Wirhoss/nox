<script setup lang="ts">
import { useI18n } from '@/shared/i18n'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import {
  type ConfigLike,
  type FieldNode,
  type FormNode,
  isObject,
  valueAt,
  type VariantNode,
} from '../model/schemaForm'

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
  secrets: readonly SecretRow[]
  value: ConfigLike
}

const NEW_SECRET = '__new_secret__'
const props = defineProps<Props>()
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

function help(node: FieldNode): string | undefined {
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

</script>

<template>
  <div class="schema-fields">
    <template v-for="node in props.nodes" :key="key(node.path)">
      <div v-if="node.kind === 'field' && node.control === 'secret'" class="schema-fields__secret">
        <div class="schema-fields__field">
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
          placeholder="SEARXNG_API_KEY"
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
            {{ option.label }}
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
          :nodes="variantChildren(node)"
          :secrets="props.secrets"
          :value="props.value"
          @credential="(path, state) => emit('credential', path, state)"
          @update="(path, next) => emit('update', path, next)"
        />
      </div>

      <div v-else class="schema-fields__nested">
        <p class="schema-fields__nested-title">{{ label(node) }}</p>
        <SchemaFieldGroup
          :credentials="props.credentials"
          :errors="props.errors"
          :extension-id="props.extensionId"
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
</style>
