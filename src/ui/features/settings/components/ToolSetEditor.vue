<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { useSettingsStore } from '../stores/settings.store'

import type { ConfigSection, ConfigValue } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'
type EndpointKey = 'extract' | 'search'
type NumericInputKey =
  | 'extractDefaultMaxCharactersPerPage'
  | 'extractMaxCharactersPerPage'
  | 'extractMaxUrls'
  | 'extractTimeoutMs'
  | 'searchDefaultMaxResults'
  | 'searchMaxResults'
  | 'searchTimeoutMs'

interface ToolSetDraft extends ConfigValue {
  extract?: ConfigValue
  search?: ConfigValue
  type: string
}

/** One endpoint's credential inputs, which live beside the draft rather than in it. */
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

const TOOL_NAMES: Readonly<Record<EndpointKey, string>> = {
  extract: 'web_extract',
  search: 'web_search',
}
const NEW_SECRET = '__new_secret__'
const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const mode = ref<EditorMode>('form')
const draft = ref<ToolSetDraft>(newToolSetTemplate())
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const jsonError = ref<string>()
const confirmingDelete = ref(false)
const disabledEndpoints = ref<Partial<Record<EndpointKey, ConfigValue>>>({})
const credentials = reactive<Record<EndpointKey, CredentialState>>({
  extract: { newId: '', selection: '', value: '' },
  search: { newId: '', selection: '', value: '' },
})
const numericInputs = reactive<Record<NumericInputKey, string>>({
  extractDefaultMaxCharactersPerPage: '30000',
  extractMaxCharactersPerPage: '100000',
  extractMaxUrls: '5',
  extractTimeoutMs: '',
  searchDefaultMaxResults: '8',
  searchMaxResults: '20',
  searchTimeoutMs: '',
})
const selectedValue = computed<ConfigValue>(() => {
  if (props.creating || props.entryId === undefined) return newToolSetTemplate()
  const value = props.section.value[props.entryId]
  return isConfigValue(value) ? value : newToolSetTemplate()
})
const title = computed(() => (props.creating ? 'New tool set' : (props.entryId ?? 'Tool set')))
const sourceName = computed(() => props.section.name)
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    if (parsed === undefined) return true
    return JSON.stringify(parsed) !== originalJsonSignature.value || credentialInputsDirty(parsed)
  }
  return formSignature() !== originalSignature.value
})

watch(
  [() => props.creating, () => props.entryId, selectedValue],
  () => {
    resetEditor()
  },
  { immediate: true },
)

function resetEditor(): void {
  draft.value = asToolSetDraft(selectedValue.value)
  mode.value = draft.value.type === 'web' ? 'form' : 'json'
  entryIdInput.value = ''
  fieldErrors.value = {}
  jsonError.value = undefined
  confirmingDelete.value = false
  disabledEndpoints.value = {}
  syncNumericInputs()
  syncCredentials()
  jsonSource.value = JSON.stringify(draft.value, undefined, 2)
  originalJsonSignature.value = JSON.stringify(draft.value)
  originalSignature.value = formSignature()
}

function formSignature(): string {
  return JSON.stringify({
    credentials,
    draft: draft.value,
    entryId: entryIdInput.value,
    numeric: numericInputs,
  })
}

function syncNumericInputs(): void {
  numericInputs.searchDefaultMaxResults = endpointNumberString('search', 'defaultMaxResults', 8)
  numericInputs.searchMaxResults = endpointNumberString('search', 'maxResults', 20)
  numericInputs.searchTimeoutMs = endpointOptionalNumberString('search', 'timeoutMs')
  numericInputs.extractDefaultMaxCharactersPerPage = endpointNumberString(
    'extract',
    'defaultMaxCharactersPerPage',
    30_000,
  )
  numericInputs.extractMaxCharactersPerPage = endpointNumberString(
    'extract',
    'maxCharactersPerPage',
    100_000,
  )
  numericInputs.extractMaxUrls = endpointNumberString('extract', 'maxUrls', 5)
  numericInputs.extractTimeoutMs = endpointOptionalNumberString('extract', 'timeoutMs')
}

function syncNumericEndpoint(key: EndpointKey): void {
  if (key === 'search') {
    numericInputs.searchDefaultMaxResults = endpointNumberString('search', 'defaultMaxResults', 8)
    numericInputs.searchMaxResults = endpointNumberString('search', 'maxResults', 20)
    numericInputs.searchTimeoutMs = endpointOptionalNumberString('search', 'timeoutMs')
  } else {
    numericInputs.extractDefaultMaxCharactersPerPage = endpointNumberString(
      'extract',
      'defaultMaxCharactersPerPage',
      30_000,
    )
    numericInputs.extractMaxCharactersPerPage = endpointNumberString(
      'extract',
      'maxCharactersPerPage',
      100_000,
    )
    numericInputs.extractMaxUrls = endpointNumberString('extract', 'maxUrls', 5)
    numericInputs.extractTimeoutMs = endpointOptionalNumberString('extract', 'timeoutMs')
  }
}

function syncCredentials(): void {
  syncCredential('search')
  syncCredential('extract')
}

function syncCredential(key: EndpointKey): void {
  const state = credentials[key]
  state.selection = endpointSecretId(draft.value, key)
  state.newId = ''
  state.value = ''
}

/**
 * Realigns the inputs after the JSON surface rewrote the draft. Only when the ID
 * actually changed: a pending value the operator already typed for the same
 * secret should survive switching back to the form.
 */
function reconcileCredential(key: EndpointKey): void {
  const state = credentials[key]
  const nextId = endpointSecretId(draft.value, key)
  const currentId = state.selection === NEW_SECRET ? state.newId.trim() : state.selection
  if (currentId === nextId) return
  state.selection = nextId
  state.newId = ''
  state.value = ''
}

function endpoint(key: EndpointKey): ConfigValue | undefined {
  const value = draft.value[key]
  return isConfigValue(value) ? value : undefined
}

function endpointString(key: EndpointKey, property: string): string {
  return stringValue(endpoint(key)?.[property])
}

function endpointNumberString(key: EndpointKey, property: string, fallback: number): string {
  const value = endpoint(key)?.[property]
  return String(typeof value === 'number' ? value : fallback)
}

function endpointOptionalNumberString(key: EndpointKey, property: string): string {
  const value = endpoint(key)?.[property]
  return typeof value === 'number' ? String(value) : ''
}

function endpointConfigured(key: EndpointKey): boolean {
  return endpoint(key) !== undefined
}

function setType(value: string): void {
  draft.value = { ...draft.value, type: value }
  clearFeedback('type')
}

function setEndpointString(key: EndpointKey, property: string, value: string): void {
  updateEndpoint(key, (current) => ({ ...current, [property]: value }))
  clearFeedback(`${key}.${property}`)
}

function setEndpointNumber(
  key: EndpointKey,
  property: string,
  inputKey: NumericInputKey,
  value: string,
  optional = false,
): void {
  numericInputs[inputKey] = value
  if (optional && value.trim().length === 0) {
    updateEndpoint(key, (current) => withoutProperty(current, property))
  } else {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      updateEndpoint(key, (current) => ({ ...current, [property]: parsed }))
    }
  }
  clearFeedback(`${key}.${property}`)
}

function updateEndpoint(key: EndpointKey, update: (value: ConfigValue) => ConfigValue): void {
  const current = endpoint(key)
  if (current === undefined) return
  draft.value = { ...draft.value, [key]: update(current) }
}

function toggleEndpoint(key: EndpointKey, enabled: boolean): void {
  if (enabled) {
    const restored = disabledEndpoints.value[key] ?? newEndpointTemplate(key)
    draft.value = { ...draft.value, [key]: cloneValue(restored) }
    disabledEndpoints.value = withoutProperty(disabledEndpoints.value, key)
    syncNumericEndpoint(key)
    syncCredential(key)
  } else {
    const current = endpoint(key)
    if (current !== undefined) {
      disabledEndpoints.value = { ...disabledEndpoints.value, [key]: cloneValue(current) }
    }
    draft.value = withoutProperty(draft.value, key) as ToolSetDraft
    credentials[key].selection = ''
    credentials[key].newId = ''
    credentials[key].value = ''
    normalizeEnabledTools()
  }
  clearFeedback('endpoints')
}

/** Every stored ID, plus whatever this endpoint already names. */
function credentialOptions(key: EndpointKey): readonly string[] {
  const ids = settings.secrets.map((secret) => secret.secretId)
  const current = endpointSecretId(draft.value, key)
  return current.length > 0 && !ids.includes(current) ? [current, ...ids] : ids
}

function selectCredential(key: EndpointKey, value: string): void {
  const state = credentials[key]
  state.selection = value
  state.newId = ''
  state.value = ''
  if (value.length === 0 || value === NEW_SECRET) {
    updateEndpoint(key, (current) => withoutProperty(current, 'apiKey'))
  } else {
    updateEndpoint(key, (current) => ({ ...current, apiKey: { $secret: value } }))
  }
  clearFeedback(`${key}.secretId`)
  clearFeedback(`${key}.secretValue`)
}

function setNewSecretId(key: EndpointKey, value: string): void {
  const state = credentials[key]
  state.newId = value
  const id = value.trim()
  updateEndpoint(key, (current) =>
    id.length === 0 ? withoutProperty(current, 'apiKey') : { ...current, apiKey: { $secret: id } },
  )
  clearFeedback(`${key}.secretId`)
}

function setSecretValue(key: EndpointKey, value: string): void {
  credentials[key].value = value
  clearFeedback(`${key}.secretValue`)
}

/**
 * Whether a value exists, not whether the ID is known: the list includes IDs
 * configuration names that nobody has filled in.
 */
function secretStored(key: EndpointKey): boolean {
  const id = endpointSecretId(draft.value, key)
  return settings.secrets.some((secret) => secret.secretId === id && secret.stored)
}

function isToolEnabled(key: EndpointKey): boolean {
  if (!endpointConfigured(key)) return false
  const enabledTools = stringArray(draft.value.enabledTools)
  return enabledTools.length === 0 || enabledTools.includes(TOOL_NAMES[key])
}

function setToolEnabled(key: EndpointKey, enabled: boolean): void {
  const configured = configuredEndpoints()
  const selected = configured.filter((candidate) => isToolEnabled(candidate))
  const next = enabled
    ? [...new Set([...selected, key])]
    : selected.filter((candidate) => candidate !== key)
  if (next.length === 0) {
    fieldErrors.value = {
      ...fieldErrors.value,
      enabledTools: 'At least one configured tool must remain exposed.',
    }
    return
  }

  const unknown = stringArray(draft.value.enabledTools).filter(
    (toolName) => !Object.values(TOOL_NAMES).includes(toolName),
  )
  draft.value =
    next.length === configured.length && unknown.length === 0
      ? (withoutProperty(draft.value, 'enabledTools') as ToolSetDraft)
      : {
          ...draft.value,
          enabledTools: [...unknown, ...next.map((candidate) => TOOL_NAMES[candidate])],
        }
  clearFeedback('enabledTools')
}

function configuredEndpoints(): EndpointKey[] {
  return (['search', 'extract'] as const).filter((key) => endpointConfigured(key))
}

function normalizeEnabledTools(): void {
  const existing = stringArray(draft.value.enabledTools)
  if (existing.length === 0) return
  const configured = configuredEndpoints()
  const configuredNames = configured.map((key) => TOOL_NAMES[key])
  const filtered = existing.filter(
    (toolName) =>
      !Object.values(TOOL_NAMES).includes(toolName) || configuredNames.includes(toolName),
  )
  const enabledKnown = filtered.filter((toolName) => configuredNames.includes(toolName))
  const unknown = filtered.filter((toolName) => !Object.values(TOOL_NAMES).includes(toolName))
  draft.value =
    configured.length > 0 && enabledKnown.length === configured.length && unknown.length === 0
      ? (withoutProperty(draft.value, 'enabledTools') as ToolSetDraft)
      : { ...draft.value, enabledTools: filtered }
}

function switchMode(nextMode: EditorMode): void {
  if (mode.value === nextMode) return
  if (nextMode === 'json') {
    jsonSource.value = JSON.stringify(draft.value, undefined, 2)
    jsonError.value = undefined
    mode.value = nextMode
    return
  }

  const parsed = parseJson(true)
  if (parsed === undefined) return
  if (stringValue(parsed.type) !== 'web') {
    jsonError.value = 'This contributed tool-set type has no curated form. Continue in JSON mode.'
    return
  }
  draft.value = asToolSetDraft(parsed)
  syncNumericInputs()
  reconcileCredential('search')
  reconcileCredential('extract')
  mode.value = nextMode
}

function formatJson(): void {
  const parsed = parseJson(true)
  if (parsed !== undefined) jsonSource.value = JSON.stringify(parsed, undefined, 2)
}

async function save(): Promise<void> {
  fieldErrors.value = {}
  jsonError.value = undefined
  let value: ConfigValue
  if (mode.value === 'json') {
    const parsed = parseJson(true)
    if (parsed === undefined) return
    value = parsed
  } else {
    if (!validateForm()) return
    value = cloneValue(draft.value)
  }

  const nextEntryId = props.creating ? entryIdInput.value.trim() : props.entryId
  if (nextEntryId === undefined || !validEntryId(nextEntryId)) {
    fieldErrors.value = {
      ...fieldErrors.value,
      entryId:
        'Use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
    }
    return
  }

  const secretWrites = collectSecretWrites(value)
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
 * The credential values to write alongside this entry, or `undefined` when the
 * inputs cannot be honoured. Both endpoints may name one ID, so a value is
 * written once — and two different values for the same ID is a contradiction the
 * operator has to resolve rather than a race to whichever runs last.
 */
function collectSecretWrites(
  value: ConfigValue,
): readonly { readonly secretId: string; readonly value: string }[] | undefined {
  const writes = new Map<string, string>()
  for (const key of ['search', 'extract'] as const) {
    const pendingValue = credentials[key].value
    if (pendingValue.length === 0) continue
    const secretId = endpointSecretId(value, key)
    if (!validSecretId(secretId)) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`${key}.secretId`]: 'Choose a valid secret ID before entering its value.',
      }
      return undefined
    }
    const duplicate = writes.get(secretId)
    if (duplicate !== undefined && duplicate !== pendingValue) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`${key}.secretValue`]: 'Both endpoints use this secret ID but specify different values.',
      }
      return undefined
    }
    writes.set(secretId, pendingValue)
  }
  return [...writes].map(([secretId, secretValue]) => ({ secretId, value: secretValue }))
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (draft.value.type !== 'web') errors.type = 'Use JSON mode for contributed tool-set types.'
  if (props.creating && !validEntryId(entryIdInput.value.trim())) {
    errors.entryId =
      'Use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
  }

  const configured = configuredEndpoints()
  if (configured.length === 0) errors.endpoints = 'Configure search, extract, or both.'
  if (configured.length > 0 && !configured.some((key) => isToolEnabled(key))) {
    errors.enabledTools = 'At least one configured tool must remain exposed.'
  }
  for (const key of configured) validateEndpoint(key, errors)

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateEndpoint(key: EndpointKey, errors: Record<string, string>): void {
  const url = endpointString(key, 'url')
  if (!validHttpUrl(url)) errors[`${key}.url`] = 'Enter an absolute HTTP or HTTPS URL.'
  validatePositiveInteger(errors, key, 'timeoutMs', true)

  if (key === 'search') {
    if (endpointString(key, 'defaultLanguage').trim().length === 0) {
      errors['search.defaultLanguage'] = 'Default language is required.'
    }
    const defaultMax = validatePositiveInteger(errors, key, 'defaultMaxResults')
    const maximum = validatePositiveInteger(errors, key, 'maxResults')
    if (defaultMax !== undefined && maximum !== undefined && defaultMax > maximum) {
      errors['search.defaultMaxResults'] = 'The default cannot exceed the endpoint maximum.'
    }
  } else {
    const defaultMax = validatePositiveInteger(errors, key, 'defaultMaxCharactersPerPage')
    const maximum = validatePositiveInteger(errors, key, 'maxCharactersPerPage')
    validatePositiveInteger(errors, key, 'maxUrls')
    if (defaultMax !== undefined && maximum !== undefined && defaultMax > maximum) {
      errors['extract.defaultMaxCharactersPerPage'] =
        'The default cannot exceed the endpoint maximum.'
    }
  }

  const state = credentials[key]
  if (state.selection === NEW_SECRET) {
    if (!validSecretId(state.newId.trim())) {
      errors[`${key}.secretId`] =
        'Use up to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
    }
    if (state.value.length === 0) {
      errors[`${key}.secretValue`] = 'Enter the value for the new managed secret.'
    }
  }
}

function validatePositiveInteger(
  errors: Record<string, string>,
  key: EndpointKey,
  property: string,
  optional = false,
): number | undefined {
  const value = numericInput(key, property).trim()
  if (optional && value.length === 0) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors[`${key}.${property}`] = 'Use a positive whole number.'
    return undefined
  }
  return parsed
}

function numericInput(key: EndpointKey, property: string): string {
  const inputKey =
    `${key}${property.charAt(0).toUpperCase()}${property.slice(1)}` as NumericInputKey
  return numericInputs[inputKey]
}

/**
 * The credential inputs sit outside the draft, so the JSON surface would
 * otherwise look unchanged while a pending value waits to be written.
 */
function credentialInputsDirty(value: ConfigValue): boolean {
  return (['search', 'extract'] as const).some((key) => {
    const state = credentials[key]
    return (
      state.value.length > 0 ||
      state.newId.length > 0 ||
      state.selection !== endpointSecretId(value, key)
    )
  })
}

function parseJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) jsonError.value = 'Tool-set configuration must be one JSON object.'
      return undefined
    }
    if (report) jsonError.value = undefined
    return parsed
  } catch (error) {
    if (report) {
      jsonError.value =
        error instanceof SyntaxError ? error.message : 'Configuration is not valid JSON.'
    }
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
    fieldErrors.value = withoutProperty(fieldErrors.value, field) as Readonly<
      Record<string, string>
    >
  }
  settings.clearMutation()
}

function canLeave(): boolean {
  return !dirty.value || window.confirm('Discard the unsaved tool-set changes?')
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function asToolSetDraft(value: ConfigValue): ToolSetDraft {
  const cloned = cloneValue(value)
  const type = stringValue(cloned.type)
  if (type !== 'web') return { ...cloned, type }
  const search = isConfigValue(cloned.search) ? withSearchDefaults(cloned.search) : undefined
  const extract = isConfigValue(cloned.extract) ? withExtractDefaults(cloned.extract) : undefined
  return {
    ...cloned,
    ...(extract === undefined ? {} : { extract }),
    ...(search === undefined ? {} : { search }),
    type,
  }
}

function withSearchDefaults(value: ConfigValue): ConfigValue {
  return {
    ...value,
    defaultLanguage:
      stringValue(value.defaultLanguage).length > 0 ? stringValue(value.defaultLanguage) : 'all',
    defaultMaxResults: numberValue(value.defaultMaxResults, 8),
    maxResults: numberValue(value.maxResults, 20),
    url: stringValue(value.url),
  }
}

function withExtractDefaults(value: ConfigValue): ConfigValue {
  return {
    ...value,
    defaultMaxCharactersPerPage: numberValue(value.defaultMaxCharactersPerPage, 30_000),
    maxCharactersPerPage: numberValue(value.maxCharactersPerPage, 100_000),
    maxUrls: numberValue(value.maxUrls, 5),
    url: stringValue(value.url),
  }
}

function newToolSetTemplate(): ToolSetDraft {
  return { search: newEndpointTemplate('search'), type: 'web' }
}

function newEndpointTemplate(key: EndpointKey): ConfigValue {
  return key === 'search'
    ? { defaultLanguage: 'all', defaultMaxResults: 8, maxResults: 20, url: '' }
    : {
        defaultMaxCharactersPerPage: 30_000,
        maxCharactersPerPage: 100_000,
        maxUrls: 5,
        url: '',
      }
}

/** The ID this endpoint's `apiKey` names, or empty when it names none. */
function endpointSecretId(value: ConfigValue, key: EndpointKey): string {
  const candidate = value[key]
  if (!isConfigValue(candidate) || !isConfigValue(candidate.apiKey)) return ''
  return stringValue(candidate.apiKey.$secret)
}

function validEntryId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function validSecretId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function validHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === 'string')
    : []
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function cloneValue<T extends ConfigValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withoutProperty(value: ConfigValue, property: string): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}
</script>

<template>
  <article class="tool-set-editor">
    <header class="tool-set-editor__header">
      <div>
        <p>TOOL SET // {{ props.entryId?.toUpperCase() ?? 'NEW' }}</p>
        <h2>{{ title }}</h2>
        <span>{{ props.definition.description }}</span>
      </div>
      <div class="tool-set-editor__header-side">
        <div class="tool-set-editor__badges">
          <span>{{ sourceName }}</span>
          <span>{{ draft.type }}</span>
          <span class="tool-set-editor__badge--restart">APPLIES ON RESTART</span>
        </div>
        <div class="tool-set-editor__modes" aria-label="Editor mode">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            Form
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            JSON
          </button>
        </div>
      </div>
    </header>

    <div class="tool-set-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        title="Tool-set configuration saved"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>Restart Nox to compose this capability bundle from the saved configuration.</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        title="Tool-set change refused"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="tool-set-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        hint="Stable ID granted by agent blueprints."
        label="Tool-set ID"
        placeholder="internet"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section class="tool-set-editor__section" aria-labelledby="tool-set-surface-title">
          <div class="tool-set-editor__section-copy">
            <p>01 // SURFACE</p>
            <h3 id="tool-set-surface-title">Capability surface</h3>
            <span>
              The contributed implementation and the exact tools exposed when an agent receives this
              set.
            </span>
          </div>
          <div class="tool-set-editor__fields">
            <div
              class="tool-set-editor__field"
              :class="{ 'tool-set-editor__field--invalid': fieldErrors.type }"
            >
              <label for="tool-set-type">Tool-set type <small>REQ</small></label>
              <select
                id="tool-set-type"
                :value="draft.type"
                :aria-invalid="fieldErrors.type !== undefined"
                @change="setType(($event.target as HTMLSelectElement).value)"
              >
                <option value="web">Web tools</option>
                <option v-if="draft.type !== 'web'" :value="draft.type">
                  {{ draft.type }} · contributed
                </option>
              </select>
              <p v-if="fieldErrors.type" class="tool-set-editor__error">{{ fieldErrors.type }}</p>
            </div>

            <div class="tool-set-editor__tool-grid">
              <label v-for="key in configuredEndpoints()" :key="key" class="tool-set-editor__tool">
                <input
                  type="checkbox"
                  :checked="isToolEnabled(key)"
                  @change="setToolEnabled(key, ($event.target as HTMLInputElement).checked)"
                />
                <span>
                  <strong>{{ TOOL_NAMES[key] }}</strong>
                  <small>{{
                    key === 'search' ? 'NETWORK / READ / SEARCH' : 'NETWORK / READ / EXTRACT'
                  }}</small>
                </span>
                <em>{{ isToolEnabled(key) ? 'EXPOSED' : 'HELD' }}</em>
              </label>
            </div>
            <p v-if="fieldErrors.enabledTools" class="tool-set-editor__error">
              {{ fieldErrors.enabledTools }}
            </p>
          </div>
        </section>

        <section class="tool-set-editor__section" aria-labelledby="tool-set-search-title">
          <div class="tool-set-editor__section-copy">
            <p>02 // SEARCH</p>
            <h3 id="tool-set-search-title">SearXNG endpoint</h3>
            <span>Public web search with bounded result counts and a default language.</span>
            <label class="tool-set-editor__endpoint-toggle">
              <input
                type="checkbox"
                :checked="endpointConfigured('search')"
                @change="toggleEndpoint('search', ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ endpointConfigured('search') ? 'CONFIGURED' : 'DISABLED' }}</span>
            </label>
          </div>
          <div v-if="endpointConfigured('search')" class="tool-set-editor__endpoint">
            <NoxTextField
              id="tool-set-search-url"
              :model-value="endpointString('search', 'url')"
              :error="fieldErrors['search.url']"
              hint="Nox appends /search and requests the JSON result format."
              label="Search service URL"
              placeholder="https://search.example"
              required
              @update:model-value="setEndpointString('search', 'url', $event)"
            />
            <div class="tool-set-editor__credential">
              <div class="tool-set-editor__field">
                <label for="tool-set-search-secret">Search credential</label>
                <select
                  id="tool-set-search-secret"
                  :value="credentials.search.selection"
                  @change="selectCredential('search', ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">No credential</option>
                  <option
                    v-for="secretId in credentialOptions('search')"
                    :key="secretId"
                    :value="secretId"
                  >
                    {{ secretId }}
                  </option>
                  <option :value="NEW_SECRET">+ New managed secret</option>
                </select>
              </div>
              <div
                v-if="credentials.search.selection && credentials.search.selection !== NEW_SECRET"
                class="tool-set-editor__secret-status"
              >
                <span>{{ credentials.search.selection }}</span>
                <strong :class="{ 'tool-set-editor__secret-missing': !secretStored('search') }">
                  {{ secretStored('search') ? 'STORED' : 'MISSING' }}
                </strong>
              </div>
              <NoxTextField
                v-if="credentials.search.selection === NEW_SECRET"
                id="tool-set-search-secret-id"
                :model-value="credentials.search.newId"
                :error="fieldErrors['search.secretId']"
                hint="The tool-set config will store this ID, never its value."
                label="New search secret ID"
                placeholder="SEARXNG_API_KEY"
                required
                @update:model-value="setNewSecretId('search', $event)"
              />
              <NoxTextField
                v-if="credentials.search.selection"
                id="tool-set-search-secret-value"
                :model-value="credentials.search.value"
                autocomplete="new-password"
                :error="fieldErrors['search.secretValue']"
                hint="Blank preserves an existing value. Secrets are never read back."
                label="Search credential value"
                placeholder="Search credential value"
                :required="credentials.search.selection === NEW_SECRET"
                type="password"
                @update:model-value="setSecretValue('search', $event)"
              />
            </div>
            <div class="tool-set-editor__field-grid">
              <NoxTextField
                id="tool-set-search-language"
                :model-value="endpointString('search', 'defaultLanguage')"
                :error="fieldErrors['search.defaultLanguage']"
                hint="SearXNG language code such as en, es, or all."
                label="Default language"
                placeholder="all"
                required
                @update:model-value="setEndpointString('search', 'defaultLanguage', $event)"
              />
              <NoxTextField
                id="tool-set-search-timeout"
                :model-value="numericInputs.searchTimeoutMs"
                :error="fieldErrors['search.timeoutMs']"
                hint="Empty uses the runtime default of 30000 ms."
                label="Timeout (ms)"
                placeholder="30000"
                @update:model-value="
                  setEndpointNumber('search', 'timeoutMs', 'searchTimeoutMs', $event, true)
                "
              />
              <NoxTextField
                id="tool-set-search-default-max"
                :model-value="numericInputs.searchDefaultMaxResults"
                :error="fieldErrors['search.defaultMaxResults']"
                label="Default results"
                required
                @update:model-value="
                  setEndpointNumber(
                    'search',
                    'defaultMaxResults',
                    'searchDefaultMaxResults',
                    $event,
                  )
                "
              />
              <NoxTextField
                id="tool-set-search-max"
                :model-value="numericInputs.searchMaxResults"
                :error="fieldErrors['search.maxResults']"
                label="Maximum results"
                required
                @update:model-value="
                  setEndpointNumber('search', 'maxResults', 'searchMaxResults', $event)
                "
              />
            </div>
          </div>
          <div v-else class="tool-set-editor__disabled-endpoint">
            <strong>SEARCH TOOL OFFLINE</strong>
            <span>Enable this endpoint to expose <code>web_search</code>.</span>
          </div>
        </section>

        <section class="tool-set-editor__section" aria-labelledby="tool-set-extract-title">
          <div class="tool-set-editor__section-copy">
            <p>03 // EXTRACT</p>
            <h3 id="tool-set-extract-title">Crawl4AI endpoint</h3>
            <span>Readable page extraction with strict batch and response-size ceilings.</span>
            <label class="tool-set-editor__endpoint-toggle">
              <input
                type="checkbox"
                :checked="endpointConfigured('extract')"
                @change="toggleEndpoint('extract', ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ endpointConfigured('extract') ? 'CONFIGURED' : 'DISABLED' }}</span>
            </label>
          </div>
          <div v-if="endpointConfigured('extract')" class="tool-set-editor__endpoint">
            <NoxTextField
              id="tool-set-extract-url"
              :model-value="endpointString('extract', 'url')"
              :error="fieldErrors['extract.url']"
              hint="Crawl4AI HTTP endpoint receiving batched crawl requests."
              label="Extraction service URL"
              placeholder="https://crawl.example"
              required
              @update:model-value="setEndpointString('extract', 'url', $event)"
            />
            <div class="tool-set-editor__credential">
              <div class="tool-set-editor__field">
                <label for="tool-set-extract-secret">Extraction credential</label>
                <select
                  id="tool-set-extract-secret"
                  :value="credentials.extract.selection"
                  @change="selectCredential('extract', ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">No credential</option>
                  <option
                    v-for="secretId in credentialOptions('extract')"
                    :key="secretId"
                    :value="secretId"
                  >
                    {{ secretId }}
                  </option>
                  <option :value="NEW_SECRET">+ New managed secret</option>
                </select>
              </div>
              <div
                v-if="credentials.extract.selection && credentials.extract.selection !== NEW_SECRET"
                class="tool-set-editor__secret-status"
              >
                <span>{{ credentials.extract.selection }}</span>
                <strong :class="{ 'tool-set-editor__secret-missing': !secretStored('extract') }">
                  {{ secretStored('extract') ? 'STORED' : 'MISSING' }}
                </strong>
              </div>
              <NoxTextField
                v-if="credentials.extract.selection === NEW_SECRET"
                id="tool-set-extract-secret-id"
                :model-value="credentials.extract.newId"
                :error="fieldErrors['extract.secretId']"
                hint="The tool-set config will store this ID, never its value."
                label="New extract secret ID"
                placeholder="CRAWL4AI_API_KEY"
                required
                @update:model-value="setNewSecretId('extract', $event)"
              />
              <NoxTextField
                v-if="credentials.extract.selection"
                id="tool-set-extract-secret-value"
                :model-value="credentials.extract.value"
                autocomplete="new-password"
                :error="fieldErrors['extract.secretValue']"
                hint="Blank preserves an existing value. Secrets are never read back."
                label="Extraction credential value"
                placeholder="Extraction credential value"
                :required="credentials.extract.selection === NEW_SECRET"
                type="password"
                @update:model-value="setSecretValue('extract', $event)"
              />
            </div>
            <div class="tool-set-editor__field-grid">
              <NoxTextField
                id="tool-set-extract-timeout"
                :model-value="numericInputs.extractTimeoutMs"
                :error="fieldErrors['extract.timeoutMs']"
                hint="Empty uses the runtime default of 30000 ms."
                label="Timeout (ms)"
                placeholder="30000"
                @update:model-value="
                  setEndpointNumber('extract', 'timeoutMs', 'extractTimeoutMs', $event, true)
                "
              />
              <NoxTextField
                id="tool-set-extract-max-urls"
                :model-value="numericInputs.extractMaxUrls"
                :error="fieldErrors['extract.maxUrls']"
                label="Maximum URLs per call"
                required
                @update:model-value="
                  setEndpointNumber('extract', 'maxUrls', 'extractMaxUrls', $event)
                "
              />
              <NoxTextField
                id="tool-set-extract-default-max"
                :model-value="numericInputs.extractDefaultMaxCharactersPerPage"
                :error="fieldErrors['extract.defaultMaxCharactersPerPage']"
                label="Default characters per page"
                required
                @update:model-value="
                  setEndpointNumber(
                    'extract',
                    'defaultMaxCharactersPerPage',
                    'extractDefaultMaxCharactersPerPage',
                    $event,
                  )
                "
              />
              <NoxTextField
                id="tool-set-extract-max"
                :model-value="numericInputs.extractMaxCharactersPerPage"
                :error="fieldErrors['extract.maxCharactersPerPage']"
                label="Maximum characters per page"
                required
                @update:model-value="
                  setEndpointNumber(
                    'extract',
                    'maxCharactersPerPage',
                    'extractMaxCharactersPerPage',
                    $event,
                  )
                "
              />
            </div>
          </div>
          <div v-else class="tool-set-editor__disabled-endpoint">
            <strong>EXTRACTION TOOL OFFLINE</strong>
            <span>Enable this endpoint to expose <code>web_extract</code>.</span>
          </div>
        </section>

        <NoxNotice v-if="fieldErrors.endpoints" title="No endpoint configured" tone="danger">
          <p>{{ fieldErrors.endpoints }}</p>
        </NoxNotice>
      </template>

      <section v-else class="tool-set-editor__json" aria-labelledby="tool-set-json-title">
        <div class="tool-set-editor__section-copy">
          <p>ADVANCED SURFACE</p>
          <h3 id="tool-set-json-title">Tool-set JSON</h3>
          <span>
            Full fidelity access for contributed implementations. Credentials do not belong in this
            document; each implementation declares what Nox must supply separately.
          </span>
        </div>
        <div class="tool-set-editor__json-field">
          <div>
            <label for="tool-set-json">JSON object</label>
            <button type="button" @click="formatJson()">Format document</button>
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

      <NoxNotice v-if="confirmingDelete" title="Remove tool set?" tone="danger">
        <div class="tool-set-editor__delete-confirmation">
          <p>Nox will refuse this operation while an agent blueprint still grants this tool set.</p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">Cancel</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              Remove tool set
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
        Remove tool set
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="tool-set-editor__dirty">UNSAVED CHANGES</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">Discard</NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="!dirty && !props.creating"
          @click="save()"
        >
          Save tool set
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

.tool-set-editor__section-copy code,
.tool-set-editor__disabled-endpoint code {
  color: var(--nox-code-inline);
}

.tool-set-editor__fields,
.tool-set-editor__endpoint,
.tool-set-editor__credential {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.tool-set-editor__field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-4);
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

.tool-set-editor__credential {
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
  background: color-mix(in srgb, var(--nox-surface-1) 80%, transparent);
}

.tool-set-editor__secret-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.tool-set-editor__secret-status span,
.tool-set-editor__secret-status strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.tool-set-editor__secret-status span {
  color: var(--nox-text-secondary);
  overflow-wrap: anywhere;
}

.tool-set-editor__secret-status strong {
  color: var(--nox-status-success);
}

.tool-set-editor__secret-status .tool-set-editor__secret-missing {
  color: var(--nox-status-danger);
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
    padding-right: var(--nox-space-5);
    padding-left: var(--nox-space-5);
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

  .tool-set-editor__field-grid,
  .tool-set-editor__tool-grid {
    grid-template-columns: 1fr;
  }
}
</style>
