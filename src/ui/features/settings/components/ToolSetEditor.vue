<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import {
  activeFields,
  type ConfigLike,
  defaultsFor,
  type FieldNode,
  type FormNode,
  formNodes,
  isObject,
  seedNode,
  valueAt,
  variantAt,
  withValueAt,
} from '../model/schemaForm'
import { useSettingsStore } from '../stores/settings.store'
import SchemaFieldGroup from './SchemaFieldGroup.vue'

import type { ConfigSection } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'

/** One credential input, which lives beside the entry rather than inside it. */
interface CredentialState {
  newId: string
  selection: string
  value: string
}

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  section: ConfigSection
}

/**
 * `type` is the immutable discriminator that selected this contribution's schema,
 * never a setting. `enabledTools` is rendered as the capability grid; everything
 * else on screen comes from that already-selected schema.
 */
const FRAMED = ['enabledTools', 'type']
const NEW_SECRET = '__new_secret__'

const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { hasMessage, t } = useI18n()

const copy = (key: string, parameters: Readonly<Record<string, boolean | number | string>> = {}) =>
  t(`settings.toolSet.${key}`, parameters)

const mode = ref<EditorMode>('form')
const draft = ref<ConfigLike>({})
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const jsonError = ref<string>()
const confirmingDelete = ref(false)
/** Slots the operator switched off, kept so switching one back on restores it. */
const parked = ref<Record<string, unknown>>({})
const credentials = reactive<Record<string, CredentialState>>({})

const types = computed(() => settings.toolSetTypes)
const descriptor = computed(() =>
  types.value.find((candidate) => candidate.type === draft.value.type),
)
const nodes = computed<readonly FormNode[]>(() =>
  descriptor.value === undefined ? [] : formNodes(descriptor.value.schema, FRAMED),
)
const sections = computed(() => nodes.value.filter((node) => node.kind !== 'field'))
const plainFields = computed(() => nodes.value.filter((node) => node.kind === 'field'))
/** The tools this instance actually exposes, which only a composed instance knows. */
const inventory = computed(() =>
  settings.toolSetInventory.find((entry) => entry.id === props.entryId),
)
const enabledTools = computed(() =>
  Array.isArray(draft.value.enabledTools)
    ? draft.value.enabledTools.filter((name): name is string => typeof name === 'string')
    : [],
)

const selectedValue = computed<ConfigLike>(() => {
  if (props.creating || props.entryId === undefined) return newToolSetTemplate()
  const value = props.section.value[props.entryId]
  return isObject(value) ? value : newToolSetTemplate()
})
const title = computed(() =>
  props.creating ? copy('titleNew') : (props.entryId ?? copy('titleFallback')),
)
const sourceName = computed(() => props.section.name)
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    if (parsed === undefined) return true
    return JSON.stringify(parsed) !== originalJsonSignature.value || credentialInputsDirty()
  }
  return formSignature() !== originalSignature.value
})

watch(
  [() => props.creating, () => props.entryId, selectedValue, types],
  () => {
    resetEditor()
  },
  { immediate: true },
)

function resetEditor(): void {
  draft.value = clone(selectedValue.value)
  mode.value = descriptor.value === undefined ? 'json' : 'form'
  entryIdInput.value = ''
  fieldErrors.value = {}
  jsonError.value = undefined
  confirmingDelete.value = false
  parked.value = {}
  syncCredentials()
  jsonSource.value = JSON.stringify(editableConfig(draft.value), undefined, 2)
  originalJsonSignature.value = JSON.stringify(draft.value)
  originalSignature.value = formSignature()
}

function formSignature(): string {
  return JSON.stringify({
    credentials,
    draft: draft.value,
    entryId: entryIdInput.value,
  })
}

/** Rebuilds the credential inputs from what the entry names right now. */
function syncCredentials(): void {
  for (const name of Object.keys(credentials)) {
    credentials[name] = { newId: '', selection: '', value: '' }
    Reflect.deleteProperty(credentials, name)
  }
  for (const node of activeFields(nodes.value, draft.value)) {
    if (node.control !== 'secret') continue
    credentials[node.path.join('.')] = { newId: '', selection: secretIdAt(node), value: '' }
  }
}

function secretIdAt(node: FieldNode): string {
  const current = valueAt(draft.value, node.path)
  if (!isObject(current)) return ''
  return typeof current.$secret === 'string' ? current.$secret : ''
}

function newToolSetTemplate(): ConfigLike {
  const first = types.value[0]
  if (first === undefined) return { type: '' }
  return { ...defaultsFor(formNodes(first.schema, FRAMED)), type: first.type }
}

/**
 * One field changed. A change of a variant's discriminator is the exception
 * worth naming: switching implementations reseeds that slot, because the
 * settings of the module being left are not settings of the one arriving.
 */
function applyUpdate(path: readonly string[], value: unknown): void {
  const variant = variantAt(nodes.value, path)
  if (variant !== undefined && typeof value === 'string') {
    draft.value = withValueAt(draft.value, variant.path, seedNode(variant, value))
    syncCredentials()
    clearFeedback()
    return
  }

  draft.value = withValueAt(draft.value, path, value)
  clearFeedback(path.join('.'))
}

function applyCredential(path: readonly string[], state: Partial<CredentialState>): void {
  const key = path.join('.')
  const current = credentials[key] ?? { newId: '', selection: '', value: '' }
  credentials[key] = { ...current, ...state }
  clearFeedback(`${key}.secretId`)
  clearFeedback(`${key}.secretValue`)
}

function slotFilled(node: FormNode): boolean {
  return isObject(valueAt(draft.value, node.path))
}

function toggleSlot(node: FormNode, enabled: boolean): void {
  if (node.kind === 'field') return
  const key = node.path.join('.')

  if (enabled) {
    const restored = parked.value[key] ?? seedNode(node)
    draft.value = withValueAt(draft.value, node.path, restored)
    parked.value = Object.fromEntries(
      Object.entries(parked.value).filter(([name]) => name !== key),
    )
  } else {
    const current = valueAt(draft.value, node.path)
    if (current !== undefined) parked.value = { ...parked.value, [key]: clone(current) }
    draft.value = withValueAt(draft.value, node.path, undefined)
  }

  syncCredentials()
  clearFeedback('slots')
}

function toolEnabled(name: string): boolean {
  return enabledTools.value.length === 0 || enabledTools.value.includes(name)
}

/**
 * An empty list means every tool, so the enabled set is only written down once
 * it is a real cut. Removing the last one is refused here rather than at the
 * loader, where an instance exposing nothing is simply a set nobody can use.
 */
function setToolEnabled(name: string, enabled: boolean): void {
  const known = inventory.value?.tools.map((tool) => tool.name) ?? []
  const selected = known.filter((candidate) => toolEnabled(candidate))
  const next = enabled
    ? [...new Set([...selected, name])]
    : selected.filter((candidate) => candidate !== name)

  if (next.length === 0) {
    fieldErrors.value = { ...fieldErrors.value, enabledTools: copy('validation.oneToolExposed') }
    return
  }

  draft.value =
    next.length === known.length
      ? withValueAt(draft.value, ['enabledTools'], undefined)
      : withValueAt(draft.value, ['enabledTools'], next)
  clearFeedback('enabledTools')
}

function label(node: FormNode): string {
  const key = node.label
  const message = key === undefined ? undefined : `${descriptor.value?.extensionId ?? ''}.${key}`
  if (message !== undefined && hasMessage(message)) return t(message)
  return humanize(node.name)
}

function help(node: FormNode): string | undefined {
  const key = node.help
  const message = key === undefined ? undefined : `${descriptor.value?.extensionId ?? ''}.${key}`
  return message !== undefined && hasMessage(message) ? t(message) : undefined
}

function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[._-]+/gu, ' ')
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

function switchMode(nextMode: EditorMode): void {
  if (mode.value === nextMode) return
  if (nextMode === 'json') {
    jsonSource.value = JSON.stringify(editableConfig(draft.value), undefined, 2)
    jsonError.value = undefined
    mode.value = nextMode
    return
  }

  const parsed = parseJson(true)
  if (parsed === undefined) return
  if (!types.value.some((candidate) => candidate.type === parsed.type)) {
    jsonError.value = copy('validation.curatedFormUnavailable')
    return
  }
  draft.value = parsed
  syncCredentials()
  mode.value = nextMode
}

function formatJson(): void {
  const parsed = parseJson(true)
  if (parsed !== undefined) jsonSource.value = JSON.stringify(editableConfig(parsed), undefined, 2)
}

async function save(): Promise<void> {
  fieldErrors.value = {}
  jsonError.value = undefined

  let value: ConfigLike
  if (mode.value === 'json') {
    const parsed = parseJson(true)
    if (parsed === undefined) return
    value = parsed
  } else {
    if (!validateForm()) return
    value = clone(draft.value)
  }

  const nextEntryId = props.creating ? entryIdInput.value.trim() : props.entryId
  if (nextEntryId === undefined || !validEntryId(nextEntryId)) {
    fieldErrors.value = { ...fieldErrors.value, entryId: t('settings.validation.entryId') }
    return
  }

  const secretWrites = collectSecretWrites()
  if (secretWrites === undefined) return
  const saved = await settings.saveEntryWithSecrets(
    props.section.key,
    nextEntryId,
    value,
    props.creating,
    secretWrites,
  )
  if (saved && props.creating) emit('created', nextEntryId)
  if (saved) originalSignature.value = formSignature()
}

/**
 * The credential values to write alongside this entry, or nothing when the
 * inputs cannot be honoured. Two positions may name one ID, so a value is
 * written once — and two different values for one ID is a contradiction the
 * operator has to resolve rather than a race to whichever runs last.
 */
function collectSecretWrites():
  | readonly { readonly secretId: string; readonly value: string }[]
  | undefined {
  const writes = new Map<string, string>()

  for (const [key, state] of Object.entries(credentials)) {
    if (state.value.length === 0) continue
    const secretId = state.selection === NEW_SECRET ? state.newId.trim() : state.selection
    if (!validSecretId(secretId)) {
      fieldErrors.value = { ...fieldErrors.value, [`${key}.secretId`]: copy('validation.chooseSecretId') }
      return undefined
    }
    const duplicate = writes.get(secretId)
    if (duplicate !== undefined && duplicate !== state.value) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`${key}.secretValue`]: copy('validation.conflictingSecretValues'),
      }
      return undefined
    }
    writes.set(secretId, state.value)
  }

  return [...writes].map(([secretId, value]) => ({ secretId, value }))
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

/**
 * What the operator can be told here rather than by a refused save: a field the
 * schema requires, a URL that is not one, a number outside the bounds the
 * contribution declared. The loader still has the last word — this only keeps
 * the obvious mistakes from becoming a round trip.
 */
function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (descriptor.value === undefined) errors.type = copy('validation.useJson')
  if (props.creating && !validEntryId(entryIdInput.value.trim())) {
    errors.entryId = t('settings.validation.entryId')
  }

  for (const node of activeFields(nodes.value, draft.value)) {
    validateField(node, errors)
  }

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateField(node: FieldNode, errors: Record<string, string>): void {
  const key = node.path.join('.')
  const value = valueAt(draft.value, node.path)

  if (node.control === 'secret') {
    const state = credentials[key]
    if (state?.selection === NEW_SECRET) {
      if (!validSecretId(state.newId.trim())) errors[`${key}.secretId`] = t('settings.validation.secretId')
      if (state.value.length === 0) errors[`${key}.secretValue`] = copy('validation.secretValueRequired')
    }
    if (node.required && value === undefined) errors[key] = copy('validation.required')
    return
  }

  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    if (node.required) errors[key] = copy('validation.required')
    return
  }

  if (node.url && !(typeof value === 'string' && validHttpUrl(value))) {
    errors[key] = copy('validation.httpUrl')
    return
  }

  if (node.control === 'number') {
    if (typeof value !== 'number' || (node.integer && !Number.isInteger(value))) {
      errors[key] = t(
        node.integer ? 'settings.validation.integer' : 'settings.validation.number',
      )
      return
    }
    if (node.minimum !== undefined && value < node.minimum) {
      errors[key] = t('settings.validation.numberMinimum', { minimum: node.minimum })
      return
    }
    if (node.maximum !== undefined && value > node.maximum) {
      errors[key] = t('settings.validation.numberRange', {
        maximum: node.maximum,
        minimum: node.minimum ?? 0,
      })
    }
  }
}

/**
 * The credential inputs sit outside the entry, so the JSON surface would
 * otherwise look unchanged while a pending value waits to be written.
 */
function credentialInputsDirty(): boolean {
  return Object.values(credentials).some(
    (state) => state.value.length > 0 || state.newId.length > 0,
  )
}

function parseJson(report: boolean): ConfigLike | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isObject(parsed)) {
      if (report) jsonError.value = copy('validation.configurationObject')
      return undefined
    }
    if (report) jsonError.value = undefined
    return { ...editableConfig(parsed), type: draft.value.type }
  } catch {
    if (report) jsonError.value = t('settings.validation.invalidJson')
    return undefined
  }
}

/** Kept as a function rather than an inline pair of statements: a multi-statement
 * handler in the template is reformatted into something the Vue compiler rejects. */
function setEntryId(value: string): void {
  entryIdInput.value = value
  clearFeedback('entryId')
}

function clearFeedback(field?: string): void {
  if (field !== undefined && field in fieldErrors.value) {
    fieldErrors.value = Object.fromEntries(
      Object.entries(fieldErrors.value).filter(([key]) => key !== field),
    )
  }
  settings.clearMutation()
}

function canLeave(): boolean {
  return !dirty.value || window.confirm(copy('confirmDiscard'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function editableConfig(value: ConfigLike): ConfigLike {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'type'))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validEntryId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
}

function validSecretId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
}

function validHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
</script>

<template>
  <article class="tool-set-editor">
    <header class="tool-set-editor__header">
      <div>
        <p>
          {{ copy('header') }} //
          {{ props.entryId?.toUpperCase() ?? t('common.new').toUpperCase() }}
        </p>
        <h2>{{ title }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="tool-set-editor__header-side">
        <div class="tool-set-editor__badges">
          <span>{{ sourceName }}</span>
          <span>{{ draft.type }}</span>
          <span class="tool-set-editor__badge--restart">{{
            t('settings.editor.appliesOnRestart')
          }}</span>
        </div>
        <div class="tool-set-editor__modes" :aria-label="t('settings.editor.mode')">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            {{ t('settings.editor.form') }}
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            {{ t('settings.editor.json') }}
          </button>
        </div>
      </div>
    </header>

    <div class="tool-set-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="copy('saved')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>{{ copy('savedBody') }}</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="copy('changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="tool-set-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        :hint="copy('idHint')"
        :label="copy('id')"
        placeholder="internet"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section class="tool-set-editor__section" aria-labelledby="tool-set-surface-title">
          <div class="tool-set-editor__section-copy">
            <p>01 // {{ copy('surface') }}</p>
            <h3 id="tool-set-surface-title">{{ copy('capabilitySurface') }}</h3>
            <span>{{ copy('capabilitySurfaceHelp') }}</span>
          </div>
          <div class="tool-set-editor__fields">
            <div v-if="inventory" class="tool-set-editor__tool-grid">
              <label
                v-for="tool in inventory.tools"
                :key="tool.name"
                class="tool-set-editor__tool"
              >
                <input
                  type="checkbox"
                  :checked="toolEnabled(tool.name)"
                  @change="setToolEnabled(tool.name, ($event.target as HTMLInputElement).checked)"
                />
                <span>
                  <strong>{{ tool.name }}</strong>
                  <small>{{ tool.authority }}</small>
                </span>
                <em>{{ toolEnabled(tool.name) ? copy('exposed') : copy('held') }}</em>
              </label>
            </div>
            <p v-if="fieldErrors.enabledTools" class="tool-set-editor__error">
              {{ fieldErrors.enabledTools }}
            </p>

            <SchemaFieldGroup
              v-if="plainFields.length > 0 && descriptor"
              :credentials="credentials"
              :errors="fieldErrors"
              :extension-id="descriptor.extensionId"
              :nodes="plainFields"
              :secrets="settings.secrets"
              :value="draft"
              @credential="applyCredential"
              @update="applyUpdate"
            />
          </div>
        </section>

        <section
          v-for="(node, index) in sections"
          :key="node.path.join('.')"
          class="tool-set-editor__section"
        >
          <div class="tool-set-editor__section-copy">
            <p>{{ String(index + 2).padStart(2, '0') }} // {{ node.name.toUpperCase() }}</p>
            <h3>{{ label(node) }}</h3>
            <span v-if="help(node)">{{ help(node) }}</span>
            <label v-if="node.optional" class="tool-set-editor__endpoint-toggle">
              <input
                type="checkbox"
                :checked="slotFilled(node)"
                @change="toggleSlot(node, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ slotFilled(node) ? copy('configured') : copy('disabled') }}</span>
            </label>
          </div>

          <div v-if="slotFilled(node) && descriptor" class="tool-set-editor__endpoint">
            <SchemaFieldGroup
              :credentials="credentials"
              :errors="fieldErrors"
              :extension-id="descriptor.extensionId"
              :nodes="[node]"
              :secrets="settings.secrets"
              :value="draft"
              @credential="applyCredential"
              @update="applyUpdate"
            />
          </div>
          <div v-else class="tool-set-editor__disabled-endpoint">
            <strong>{{ copy('slotOffline') }}</strong>
            <span>{{ copy('enableSlot') }}</span>
          </div>
        </section>

        <p v-if="fieldErrors.slots" class="tool-set-editor__error">{{ fieldErrors.slots }}</p>
      </template>

      <section v-else class="tool-set-editor__json" aria-labelledby="tool-set-json-title">
        <div class="tool-set-editor__section-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3 id="tool-set-json-title">{{ copy('toolSetJson') }}</h3>
          <span>{{ copy('toolSetJsonHelp') }}</span>
        </div>
        <div class="tool-set-editor__json-field">
          <div>
            <label for="tool-set-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatJson()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="tool-set-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="tool-set-editor__error">{{ jsonError }}</p>
        </div>
      </section>

      <NoxNotice v-if="confirmingDelete" :title="copy('removeQuestion')" tone="danger">
        <div class="tool-set-editor__delete-confirmation">
          <p>{{ copy('removeWarning') }}</p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">{{
              t('common.cancel')
            }}</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              {{ copy('remove') }}
            </NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="tool-set-editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        {{ copy('remove') }}
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="tool-set-editor__dirty">{{
          t('settings.editor.unsavedChanges')
        }}</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">{{
          t('common.discard')
        }}</NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="!dirty && !props.creating"
          @click="save()"
        >
          {{ copy('save') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.tool-set-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.tool-set-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.tool-set-editor__header p,
.tool-set-editor__header span,
.tool-set-editor__section-copy p,
.tool-set-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.tool-set-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.tool-set-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.tool-set-editor__badges,
.tool-set-editor__modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.tool-set-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.tool-set-editor__badges .tool-set-editor__badge--restart {
  border-color: color-mix(in srgb, var(--nox-status-warning) 45%, var(--nox-border-subtle));
  color: var(--nox-status-warning);
}

.tool-set-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.tool-set-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.tool-set-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.tool-set-editor__content {
  display: grid;
  width: min(100%, 70rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.tool-set-editor__section,
.tool-set-editor__json {
  display: grid;
  grid-template-columns: minmax(13rem, 0.36fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-top: 1px solid var(--nox-border-subtle);
}

.tool-set-editor__section:last-of-type,
.tool-set-editor__json {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.tool-set-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.tool-set-editor__section-copy > span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.tool-set-editor__fields,
.tool-set-editor__endpoint {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.tool-set-editor__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.tool-set-editor__field > label,
.tool-set-editor__json-field label {
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

.tool-set-editor__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.tool-set-editor__field select {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.tool-set-editor__field select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.tool-set-editor__field--invalid select {
  border-color: var(--nox-status-danger);
}

.tool-set-editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.tool-set-editor__tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-3);
}

.tool-set-editor__tool {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-3);
  min-height: 5rem;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
  cursor: pointer;
}

.tool-set-editor__tool:has(input:checked) {
  border-color: color-mix(in srgb, var(--nox-action-primary) 45%, var(--nox-border-subtle));
  background: color-mix(in srgb, var(--nox-action-primary) 5%, var(--nox-surface-1));
}

.tool-set-editor__tool input,
.tool-set-editor__endpoint-toggle input {
  accent-color: var(--nox-action-primary);
}

.tool-set-editor__tool > span {
  display: grid;
  gap: var(--nox-space-1);
}

.tool-set-editor__tool strong,
.tool-set-editor__tool small,
.tool-set-editor__tool em {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.tool-set-editor__tool small {
  color: var(--nox-text-muted);
  overflow-wrap: anywhere;
}

.tool-set-editor__tool em {
  color: var(--nox-action-primary);
  font-size: 0.58rem;
  font-style: normal;
}

.tool-set-editor__endpoint-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--nox-space-2);
  margin-top: var(--nox-space-4);
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.tool-set-editor__disabled-endpoint {
  display: grid;
  min-height: 9rem;
  place-content: center;
  gap: var(--nox-space-2);
  padding: var(--nox-space-6);
  border: 1px dashed var(--nox-border-subtle);
  color: var(--nox-text-muted);
  background: color-mix(in srgb, var(--nox-surface-1) 55%, transparent);
  text-align: center;
}

.tool-set-editor__disabled-endpoint strong,
.tool-set-editor__disabled-endpoint span {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.tool-set-editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.tool-set-editor__json-field > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.tool-set-editor__json-field button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.tool-set-editor__json-field textarea {
  width: 100%;
  min-height: 38rem;
  resize: vertical;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-code-inline);
  background: var(--nox-surface-input);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  line-height: 1.65;
  tab-size: 2;
  caret-color: var(--nox-action-primary);
}

.tool-set-editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.tool-set-editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.tool-set-editor__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.tool-set-editor__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.tool-set-editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.tool-set-editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.tool-set-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 60rem) {
  .tool-set-editor__header,
  .tool-set-editor__content,
  .tool-set-editor__actions {
    padding-inline: var(--nox-space-5);
  }

  .tool-set-editor__section,
  .tool-set-editor__json {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 40rem) {
  .tool-set-editor__header,
  .tool-set-editor__actions,
  .tool-set-editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .tool-set-editor__header-side {
    justify-items: start;
  }

  .tool-set-editor__badges,
  .tool-set-editor__modes {
    justify-content: flex-start;
  }

  .tool-set-editor__tool-grid {
    grid-template-columns: 1fr;
  }
}
</style>
