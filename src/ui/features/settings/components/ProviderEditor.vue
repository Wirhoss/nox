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
type RetryInputKey = 'maxRetries' | 'maxRetryDelayMs' | 'retryDelayMs' | 'timeoutMs'

const MODEL_MODALITIES = ['text', 'image', 'audio', 'video', 'document'] as const
type ModelModality = (typeof MODEL_MODALITIES)[number]

interface ModelDraft extends ConfigValue {
  inputModalities: string[]
  modelId: string
  outputModalities: string[]
}

interface ProviderDraft extends ConfigValue {
  baseUrl: string
  maxRetries: number
  maxRetryDelayMs: number
  modelConfigs: ModelDraft[]
  retryDelayMs: number
  type: string
}

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  section: ConfigSection
}

const NEW_SECRET = '__new_secret__'
const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const mode = ref<EditorMode>('form')
const draft = ref<ProviderDraft>(newProviderTemplate())
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const credentialSelection = ref('')
const newSecretIdInput = ref('')
const secretValueInput = ref('')
const secretWriteOpen = ref(false)
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const jsonError = ref<string>()
const confirmingDelete = ref(false)
const retryInputs = reactive<Record<RetryInputKey, string>>({
  maxRetries: '2',
  maxRetryDelayMs: '30000',
  retryDelayMs: '500',
  timeoutMs: '',
})
const modelContextInputs = ref<string[]>([])
const selectedValue = computed<ConfigValue>(() => {
  if (props.creating || props.entryId === undefined) return newProviderTemplate()
  const value = props.section.value[props.entryId]
  return isConfigValue(value) ? value : newProviderTemplate()
})
const title = computed(() => (props.creating ? 'New provider' : (props.entryId ?? 'Provider')))
const sourceName = computed(() => props.section.name)
const referencedSecretId = computed(() => secretReferenceId(draft.value.apiKey))
/**
 * Every stored ID, plus whatever this entry already names. The current one is
 * kept even when no value exists for it, so opening an entry whose credential
 * has not been filled in shows what it is waiting for rather than silently
 * resetting the field to nothing.
 */
const secretOptions = computed(() => {
  const ids = settings.secrets.map((secret) => secret.secretId)
  const current = referencedSecretId.value
  return current.length > 0 && !ids.includes(current) ? [current, ...ids] : ids
})
const selectedSecret = computed(() =>
  settings.secrets.find((secret) => secret.secretId === credentialTargetId()),
)
/**
 * Known and stored are different questions: the list includes IDs configuration
 * names but nobody has filled in, so only `stored` answers whether a request
 * through this provider would authenticate.
 */
const selectedSecretStored = computed(() => selectedSecret.value?.stored === true)
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    if (parsed === undefined) return true
    return JSON.stringify(parsed) !== originalJsonSignature.value || secretInputsDirty()
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
  draft.value = asProviderDraft(selectedValue.value)
  entryIdInput.value = ''
  newSecretIdInput.value = ''
  secretValueInput.value = ''
  secretWriteOpen.value = false
  credentialSelection.value = referencedSecretId.value
  fieldErrors.value = {}
  jsonError.value = undefined
  confirmingDelete.value = false
  syncNumericInputs()
  jsonSource.value = JSON.stringify(draft.value, undefined, 2)
  originalJsonSignature.value = JSON.stringify(draft.value)
  originalSignature.value = formSignature()
}

function syncNumericInputs(): void {
  retryInputs.maxRetries = String(draft.value.maxRetries)
  retryInputs.maxRetryDelayMs = String(draft.value.maxRetryDelayMs)
  retryInputs.retryDelayMs = String(draft.value.retryDelayMs)
  retryInputs.timeoutMs = optionalNumber(draft.value.timeoutMs)
  modelContextInputs.value = draft.value.modelConfigs.map((model) =>
    optionalNumber(model.contextWindow),
  )
}

function formSignature(): string {
  return JSON.stringify({
    credential: credentialSelection.value,
    draft: draft.value,
    entryId: entryIdInput.value,
    modelContexts: modelContextInputs.value,
    newSecretId: newSecretIdInput.value,
    retry: retryInputs,
    secretValue: secretValueInput.value,
  })
}

/**
 * The credential inputs are not part of the draft, so a change to them would
 * otherwise leave the editor looking untouched while a value waits to be sent.
 */
function secretInputsDirty(): boolean {
  return (
    secretValueInput.value.length > 0 ||
    newSecretIdInput.value.length > 0 ||
    credentialSelection.value !== referencedSecretId.value
  )
}

function setString(field: 'baseUrl' | 'type', value: string): void {
  draft.value = { ...draft.value, [field]: value }
  clearFeedback(field)
}

function defaultModel(): string {
  return stringValue(draft.value.defaultModel)
}

function setDefaultModel(value: string): void {
  draft.value =
    value.trim().length === 0
      ? (withoutProperty(draft.value, 'defaultModel') as ProviderDraft)
      : { ...draft.value, defaultModel: value }
  clearFeedback('defaultModel')
}

/**
 * Choosing which managed secret this provider uses. The draft holds the ID and
 * only the ID: the value never enters configuration, in either direction.
 */
function selectCredential(value: string): void {
  credentialSelection.value = value
  secretValueInput.value = ''
  fieldErrors.value = withoutProperties(fieldErrors.value, ['secretId', 'secretValue'])

  if (value === NEW_SECRET) {
    newSecretIdInput.value = ''
    secretWriteOpen.value = true
    draft.value = withoutProperty(draft.value, 'apiKey') as ProviderDraft
  } else if (value.length === 0) {
    newSecretIdInput.value = ''
    secretWriteOpen.value = false
    draft.value = withoutProperty(draft.value, 'apiKey') as ProviderDraft
  } else {
    newSecretIdInput.value = ''
    secretWriteOpen.value = false
    draft.value = { ...draft.value, apiKey: { $secret: value } }
  }
  settings.clearMutation()
}

function setNewSecretId(value: string): void {
  newSecretIdInput.value = value
  const id = value.trim()
  draft.value =
    id.length === 0
      ? (withoutProperty(draft.value, 'apiKey') as ProviderDraft)
      : { ...draft.value, apiKey: { $secret: id } }
  clearFeedback('secretId')
}

function setSecretValue(value: string): void {
  secretValueInput.value = value
  clearFeedback('secretValue')
}

function openSecretWrite(): void {
  secretWriteOpen.value = true
  secretValueInput.value = ''
  settings.clearMutation()
}

function closeSecretWrite(): void {
  secretWriteOpen.value = false
  secretValueInput.value = ''
  clearFeedback('secretValue')
}

function credentialTargetId(value: ConfigValue = draft.value): string {
  return secretReferenceId(value.apiKey)
}

function setRetryNumber(key: RetryInputKey, value: string): void {
  retryInputs[key] = value
  if (value.trim().length === 0 && key === 'timeoutMs') {
    draft.value = withoutProperty(draft.value, key) as ProviderDraft
  } else {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) draft.value = { ...draft.value, [key]: parsed }
  }
  clearFeedback(key)
}

function setModelField(index: number, value: string): void {
  const model = draft.value.modelConfigs[index]
  if (model === undefined) return
  const models = draft.value.modelConfigs.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, modelId: value } : candidate,
  )
  draft.value = { ...draft.value, modelConfigs: models }
  clearFeedback(`model.${String(index)}.modelId`)
}

function setModelModality(
  index: number,
  field: 'inputModalities' | 'outputModalities',
  modality: ModelModality,
  enabled: boolean,
): void {
  const model = draft.value.modelConfigs[index]
  if (model === undefined || modality === 'text') return
  const current = model[field]
  const nextModalities = enabled
    ? [...new Set([...current, modality])]
    : current.filter((candidate) => candidate !== modality)
  draft.value = {
    ...draft.value,
    modelConfigs: draft.value.modelConfigs.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, [field]: nextModalities } : candidate,
    ),
  }
  clearFeedback(`model.${String(index)}.${field}`)
}

function setModelContext(index: number, value: string): void {
  modelContextInputs.value = modelContextInputs.value.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  )
  const model = draft.value.modelConfigs[index]
  if (model === undefined) return
  const parsed = Number(value)
  const nextModel =
    value.trim().length === 0
      ? withoutProperty(model, 'contextWindow')
      : Number.isFinite(parsed)
        ? { ...model, contextWindow: parsed }
        : model
  draft.value = {
    ...draft.value,
    modelConfigs: draft.value.modelConfigs.map((candidate, candidateIndex) =>
      candidateIndex === index ? (nextModel as ModelDraft) : candidate,
    ),
  }
  clearFeedback(`model.${String(index)}.contextWindow`)
}

function addModel(): void {
  draft.value = {
    ...draft.value,
    modelConfigs: [
      ...draft.value.modelConfigs,
      { inputModalities: ['text'], modelId: '', outputModalities: ['text'] },
    ],
  }
  modelContextInputs.value = [...modelContextInputs.value, '']
  settings.clearMutation()
}

function removeModel(index: number): void {
  draft.value = {
    ...draft.value,
    modelConfigs: draft.value.modelConfigs.filter((_, candidateIndex) => candidateIndex !== index),
  }
  modelContextInputs.value = modelContextInputs.value.filter(
    (_, candidateIndex) => candidateIndex !== index,
  )
  settings.clearMutation()
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
  draft.value = asProviderDraft(parsed)
  credentialSelection.value = referencedSecretId.value
  syncNumericInputs()
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

  const secretId = credentialTargetId(value)
  if (secretValueInput.value.length > 0 && !validSecretId(secretId)) {
    fieldErrors.value = { ...fieldErrors.value, secretId: 'Choose a valid secret ID first.' }
    return
  }
  const secretWrite =
    secretValueInput.value.length === 0 ? undefined : { secretId, value: secretValueInput.value }
  const saved = await settings.saveEntryWithSecrets(
    props.section.key,
    nextEntryId,
    value,
    props.creating,
    secretWrite === undefined ? [] : [secretWrite],
  )
  if (saved && props.creating) emit('created', nextEntryId)
  if (saved) originalSignature.value = formSignature()
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (draft.value.type.trim().length === 0) errors.type = 'Provider type is required.'
  if (draft.value.baseUrl.trim().length === 0) {
    errors.baseUrl = 'Base URL is required.'
  } else {
    try {
      new URL(draft.value.baseUrl)
    } catch {
      errors.baseUrl = 'Enter an absolute provider URL.'
    }
  }

  if (props.creating && !validEntryId(entryIdInput.value.trim())) {
    errors.entryId =
      'Use up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
  }

  validateRetry(errors, 'maxRetries', 0, true)
  validateRetry(errors, 'maxRetryDelayMs', 0)
  validateRetry(errors, 'retryDelayMs', 0)
  validateRetry(errors, 'timeoutMs', Number.MIN_VALUE)

  const modelIds = new Set<string>()
  draft.value.modelConfigs.forEach((model, index) => {
    const prefix = `model.${String(index)}`
    if (model.modelId.trim().length === 0) {
      errors[`${prefix}.modelId`] = 'Model ID is required.'
    } else if (modelIds.has(model.modelId)) {
      errors[`${prefix}.modelId`] = 'Model IDs must be unique inside one provider.'
    }
    modelIds.add(model.modelId)

    const context = modelContextInputs.value[index]?.trim() ?? ''
    if (context.length > 0 && (!Number.isInteger(Number(context)) || Number(context) <= 0)) {
      errors[`${prefix}.contextWindow`] = 'Use a positive whole number.'
    }
    if (!model.inputModalities.includes('text')) {
      errors[`${prefix}.inputModalities`] = 'The chat interface requires text input.'
    }
    if (!model.outputModalities.includes('text')) {
      errors[`${prefix}.outputModalities`] = 'The chat interface requires text output.'
    }
  })

  if (credentialSelection.value === NEW_SECRET) {
    const secretId = newSecretIdInput.value.trim()
    if (!validSecretId(secretId)) {
      errors.secretId =
        'Use up to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
    }
    if (secretValueInput.value.length === 0) {
      errors.secretValue = 'Enter the value for the new managed secret.'
    }
  }

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateRetry(
  errors: Record<string, string>,
  key: RetryInputKey,
  minimum: number,
  integer = false,
): void {
  const input = retryInputs[key].trim()
  if (key === 'timeoutMs' && input.length === 0) return
  const value = Number(input)
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    errors[key] = `Use ${integer ? 'a whole number' : 'a number'} of at least ${String(minimum)}.`
  }
}

function parseJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) jsonError.value = 'Provider configuration must be one JSON object.'
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
  return !dirty.value || window.confirm('Discard the unsaved provider changes?')
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function asProviderDraft(value: ConfigValue): ProviderDraft {
  const cloned = cloneValue(value)
  return {
    ...cloned,
    baseUrl: stringValue(cloned.baseUrl),
    maxRetries: numberValue(cloned.maxRetries, 2),
    maxRetryDelayMs: numberValue(cloned.maxRetryDelayMs, 30_000),
    modelConfigs: modelConfigs(cloned.modelConfigs),
    retryDelayMs: numberValue(cloned.retryDelayMs, 500),
    type: stringValue(cloned.type),
  }
}

function newProviderTemplate(): ProviderDraft {
  return {
    baseUrl: '',
    maxRetries: 2,
    maxRetryDelayMs: 30_000,
    modelConfigs: [],
    retryDelayMs: 500,
    type: 'openai_completions',
  }
}

function modelConfigs(value: unknown): ModelDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): ModelDraft[] => {
    if (!isConfigValue(candidate)) return []
    return [
      {
        ...withoutProperty(candidate, 'type'),
        inputModalities: modalities(candidate.inputModalities),
        modelId: stringValue(candidate.modelId),
        outputModalities: modalities(candidate.outputModalities),
      },
    ]
  })
}

/** Missing capability metadata is deliberately text-only. */
function modalities(value: unknown): string[] {
  if (!Array.isArray(value)) return ['text']
  const declared = [
    ...new Set(value.filter((candidate): candidate is string => typeof candidate === 'string')),
  ]
  return declared.includes('text') ? declared : ['text', ...declared]
}

function secretReferenceId(value: unknown): string {
  return isConfigValue(value) ? stringValue(value.$secret) : ''
}

function validEntryId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function validSecretId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function optionalNumber(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

function cloneValue<T extends ConfigValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withoutProperty(value: ConfigValue, property: string): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}

function withoutProperties(
  value: Readonly<Record<string, string>>,
  properties: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !properties.includes(key)))
}
</script>

<template>
  <article class="provider-editor">
    <header class="provider-editor__header">
      <div>
        <p>MODEL PROVIDER // {{ props.entryId?.toUpperCase() ?? 'NEW' }}</p>
        <h2>{{ title }}</h2>
        <span>{{ props.definition.description }}</span>
      </div>
      <div class="provider-editor__header-side">
        <div class="provider-editor__badges">
          <span>{{ sourceName }}</span>
          <span>{{ draft.type }}</span>
          <span class="provider-editor__badge--restart">APPLIES ON RESTART</span>
        </div>
        <div class="provider-editor__modes" aria-label="Editor mode">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            Form
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            JSON
          </button>
        </div>
      </div>
    </header>

    <div class="provider-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        title="Provider configuration saved"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>Restart Nox to compose this provider from the saved configuration.</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        title="Provider change refused"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="provider-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        hint="Stable ID referenced by agent blueprints."
        label="Provider ID"
        placeholder="main"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section class="provider-editor__section" aria-labelledby="provider-adapter-title">
          <div class="provider-editor__section-copy">
            <p>01 // ADAPTER</p>
            <h3 id="provider-adapter-title">Endpoint identity</h3>
            <span>The contributed adapter and the remote API endpoint it speaks to.</span>
          </div>
          <div class="provider-editor__fields">
            <div
              class="provider-editor__field"
              :class="{ 'provider-editor__field--invalid': fieldErrors.type }"
            >
              <label for="provider-type">Provider type <small>REQ</small></label>
              <select
                id="provider-type"
                :value="draft.type"
                :aria-invalid="fieldErrors.type !== undefined"
                @change="setString('type', ($event.target as HTMLSelectElement).value)"
              >
                <option value="openai_completions">OpenAI-compatible completions</option>
                <option v-if="draft.type !== 'openai_completions'" :value="draft.type">
                  {{ draft.type }} · contributed
                </option>
              </select>
              <p v-if="fieldErrors.type" class="provider-editor__error">{{ fieldErrors.type }}</p>
            </div>
            <NoxTextField
              id="provider-base-url"
              :model-value="draft.baseUrl"
              :error="fieldErrors.baseUrl"
              hint="Base path before /models and /chat/completions."
              label="Base URL"
              placeholder="https://api.example.com/v1"
              required
              type="text"
              @update:model-value="setString('baseUrl', $event)"
            />
          </div>
        </section>

        <section class="provider-editor__section" aria-labelledby="provider-credential-title">
          <div class="provider-editor__section-copy">
            <p>02 // CREDENTIAL</p>
            <h3 id="provider-credential-title">Managed secret</h3>
            <span>
              Configuration stores only a secret reference. Values enter through the write-only
              Secrets surface and never return to this form.
            </span>
          </div>
          <div class="provider-editor__credentials">
            <div class="provider-editor__field">
              <label for="provider-secret">API credential</label>
              <select
                id="provider-secret"
                :value="credentialSelection"
                @change="selectCredential(($event.target as HTMLSelectElement).value)"
              >
                <option value="">No credential</option>
                <option v-for="secretId in secretOptions" :key="secretId" :value="secretId">
                  {{ secretId }}
                </option>
                <option :value="NEW_SECRET">+ New managed secret</option>
              </select>
            </div>

            <NoxTextField
              v-if="credentialSelection === NEW_SECRET"
              id="provider-new-secret-id"
              :model-value="newSecretIdInput"
              :error="fieldErrors.secretId"
              hint="The provider config will store this ID, never its value."
              label="New secret ID"
              placeholder="OPENAI_API_KEY"
              required
              @update:model-value="setNewSecretId($event)"
            />

            <div
              v-if="credentialSelection.length > 0 && credentialSelection !== NEW_SECRET"
              class="provider-editor__secret-status"
            >
              <div>
                <span>SECRET REFERENCE</span>
                <strong>{{ credentialSelection }}</strong>
              </div>
              <div>
                <span>STORE STATUS</span>
                <strong :class="{ 'provider-editor__secret-missing': !selectedSecretStored }">
                  {{ selectedSecretStored ? 'STORED' : 'MISSING' }}
                </strong>
              </div>
              <NoxButton v-if="!secretWriteOpen" variant="secondary" @click="openSecretWrite()">
                Replace value
              </NoxButton>
            </div>

            <div v-if="secretWriteOpen" class="provider-editor__secret-write">
              <NoxTextField
                id="provider-secret-value"
                :model-value="secretValueInput"
                autocomplete="new-password"
                :error="fieldErrors.secretValue"
                hint="Intentionally blank even when this secret already exists."
                label="New secret value"
                placeholder="Value will not be shown again"
                :required="credentialSelection === NEW_SECRET"
                type="password"
                @update:model-value="setSecretValue($event)"
              />
              <NoxButton
                v-if="credentialSelection !== NEW_SECRET"
                variant="ghost"
                @click="closeSecretWrite()"
              >
                Cancel value update
              </NoxButton>
            </div>
          </div>
        </section>

        <section class="provider-editor__section" aria-labelledby="provider-models-title">
          <div class="provider-editor__section-copy">
            <p>03 // MODELS</p>
            <h3 id="provider-models-title">Model catalog</h3>
            <span>
              Declared model metadata anchors context accounting and optional sampling defaults.
            </span>
          </div>
          <div class="provider-editor__models">
            <NoxTextField
              id="provider-default-model"
              :model-value="defaultModel()"
              hint="Used when a caller does not provide a model override."
              label="Default model"
              list="provider-model-options"
              placeholder="Optional model ID"
              @update:model-value="setDefaultModel($event)"
            />
            <datalist id="provider-model-options">
              <option
                v-for="model in draft.modelConfigs"
                :key="model.modelId"
                :value="model.modelId"
              ></option>
            </datalist>

            <div class="provider-editor__model-list">
              <article
                v-for="(model, index) in draft.modelConfigs"
                :key="index"
                class="provider-editor__model"
              >
                <header>
                  <span>MODEL // {{ String(index + 1).padStart(2, '0') }}</span>
                  <button type="button" @click="removeModel(index)">Remove</button>
                </header>
                <div class="provider-editor__field-grid">
                  <NoxTextField
                    :id="`provider-model-${String(index)}-id`"
                    :model-value="model.modelId"
                    :error="fieldErrors[`model.${String(index)}.modelId`]"
                    label="Model ID"
                    placeholder="model-id"
                    required
                    @update:model-value="setModelField(index, $event)"
                  />
                  <NoxTextField
                    :id="`provider-model-${String(index)}-context`"
                    :model-value="modelContextInputs[index] ?? ''"
                    :error="fieldErrors[`model.${String(index)}.contextWindow`]"
                    hint="Canonical context capacity in tokens."
                    label="Context window"
                    placeholder="131072"
                    @update:model-value="setModelContext(index, $event)"
                  />
                </div>
                <fieldset class="provider-editor__modalities">
                  <legend>Accepted input modalities</legend>
                  <label v-for="modality in MODEL_MODALITIES" :key="modality">
                    <input
                      type="checkbox"
                      :checked="model.inputModalities.includes(modality)"
                      :disabled="modality === 'text'"
                      @change="
                        setModelModality(
                          index,
                          'inputModalities',
                          modality,
                          ($event.target as HTMLInputElement).checked,
                        )
                      "
                    />
                    <span>{{ modality }}</span>
                  </label>
                  <small>
                    Declare only inputs this exact model accepts. Provider adapters still validate
                    whether they can encode each modality.
                  </small>
                  <p
                    v-if="fieldErrors[`model.${String(index)}.inputModalities`]"
                    class="provider-editor__error"
                  >
                    {{ fieldErrors[`model.${String(index)}.inputModalities`] }}
                  </p>
                </fieldset>
                <fieldset class="provider-editor__modalities">
                  <legend>Generated output modalities</legend>
                  <label v-for="modality in MODEL_MODALITIES" :key="modality">
                    <input
                      type="checkbox"
                      :checked="model.outputModalities.includes(modality)"
                      :disabled="modality === 'text'"
                      @change="
                        setModelModality(
                          index,
                          'outputModalities',
                          modality,
                          ($event.target as HTMLInputElement).checked,
                        )
                      "
                    />
                    <span>{{ modality }}</span>
                  </label>
                  <small>
                    Outputs are independent from accepted inputs. The current chat stream always
                    requires text output.
                  </small>
                  <p
                    v-if="fieldErrors[`model.${String(index)}.outputModalities`]"
                    class="provider-editor__error"
                  >
                    {{ fieldErrors[`model.${String(index)}.outputModalities`] }}
                  </p>
                </fieldset>
                <p
                  v-if="
                    Object.keys(model).some(
                      (key) =>
                        ![
                          'contextWindow',
                          'inputModalities',
                          'modelId',
                          'outputModalities',
                        ].includes(key),
                    )
                  "
                >
                  Additional sampling fields are preserved and available in JSON mode.
                </p>
              </article>
            </div>
            <button class="provider-editor__add-model" type="button" @click="addModel()">
              + Add model configuration
            </button>
          </div>
        </section>

        <details class="provider-editor__advanced-group">
          <summary>
            <span>04 // RESILIENCE</span>
            <strong>Retries and timeout</strong>
            <small>Connection timing applied to this provider instance.</small>
          </summary>
          <div class="provider-editor__retry-grid">
            <NoxTextField
              id="provider-max-retries"
              :model-value="retryInputs.maxRetries"
              :error="fieldErrors.maxRetries"
              label="Maximum retries"
              @update:model-value="setRetryNumber('maxRetries', $event)"
            />
            <NoxTextField
              id="provider-retry-delay"
              :model-value="retryInputs.retryDelayMs"
              :error="fieldErrors.retryDelayMs"
              label="Initial retry delay (ms)"
              @update:model-value="setRetryNumber('retryDelayMs', $event)"
            />
            <NoxTextField
              id="provider-max-retry-delay"
              :model-value="retryInputs.maxRetryDelayMs"
              :error="fieldErrors.maxRetryDelayMs"
              label="Maximum retry delay (ms)"
              @update:model-value="setRetryNumber('maxRetryDelayMs', $event)"
            />
            <NoxTextField
              id="provider-timeout"
              :model-value="retryInputs.timeoutMs"
              :error="fieldErrors.timeoutMs"
              hint="Empty means no provider-level timeout."
              label="Request timeout (ms)"
              @update:model-value="setRetryNumber('timeoutMs', $event)"
            />
          </div>
        </details>
      </template>

      <section v-else class="provider-editor__json" aria-labelledby="provider-json-title">
        <div class="provider-editor__section-copy">
          <p>ADVANCED SURFACE</p>
          <h3 id="provider-json-title">Provider JSON</h3>
          <span>
            Full fidelity access for contributed adapters and model sampling fields. Credentials do
            not belong in this document; each adapter declares what Nox must supply separately.
          </span>
        </div>
        <div class="provider-editor__json-field">
          <div>
            <label for="provider-json">JSON object</label>
            <button type="button" @click="formatJson()">Format document</button>
          </div>
          <textarea
            id="provider-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="provider-editor__error">{{ jsonError }}</p>
        </div>
      </section>

      <NoxNotice v-if="confirmingDelete" title="Remove provider?" tone="danger">
        <div class="provider-editor__delete-confirmation">
          <p>Nox will refuse this operation while an agent blueprint still names this provider.</p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">Cancel</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              Remove provider
            </NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="provider-editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        Remove provider
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="provider-editor__dirty">UNSAVED CHANGES</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">Discard</NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="!dirty && !props.creating"
          @click="save()"
        >
          Save provider
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.provider-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.provider-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.provider-editor__header p,
.provider-editor__header span,
.provider-editor__section-copy p,
.provider-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.provider-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.provider-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.provider-editor__badges,
.provider-editor__modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.provider-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.provider-editor__badges .provider-editor__badge--restart {
  border-color: color-mix(in srgb, var(--nox-status-warning) 45%, var(--nox-border-subtle));
  color: var(--nox-status-warning);
}

.provider-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.provider-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.provider-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.provider-editor__content {
  display: grid;
  width: min(100%, 68rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.provider-editor__section,
.provider-editor__json {
  display: grid;
  grid-template-columns: minmax(13rem, 0.36fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-top: 1px solid var(--nox-border-subtle);
}

.provider-editor__section:last-of-type,
.provider-editor__json {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.provider-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.provider-editor__section-copy span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.provider-editor__section-copy code {
  color: var(--nox-code-inline);
}

.provider-editor__fields,
.provider-editor__credentials,
.provider-editor__models {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.provider-editor__field-grid,
.provider-editor__retry-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-4);
}

.provider-editor__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.provider-editor__field > label,
.provider-editor__json-field label {
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

.provider-editor__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.provider-editor__field select {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.provider-editor__field select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.provider-editor__field--invalid select {
  border-color: var(--nox-status-danger);
}

.provider-editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.provider-editor__secret-status {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.provider-editor__secret-status > div {
  display: grid;
}

.provider-editor__secret-status span,
.provider-editor__secret-status strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.provider-editor__secret-status span {
  color: var(--nox-text-muted);
}

.provider-editor__secret-status strong {
  color: var(--nox-status-success);
  overflow-wrap: anywhere;
}

.provider-editor__secret-status .provider-editor__secret-missing {
  color: var(--nox-status-danger);
}

.provider-editor__secret-write {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-status-info);
  background: color-mix(in srgb, var(--nox-status-info) 4%, transparent);
}

.provider-editor__model-list {
  display: grid;
  gap: var(--nox-space-4);
}

.provider-editor__model {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.provider-editor__model header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding-bottom: var(--nox-space-3);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.provider-editor__model header span,
.provider-editor__model header button,
.provider-editor__model > p {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.provider-editor__model header button {
  padding: var(--nox-space-1) var(--nox-space-2);
  background: transparent;
  cursor: pointer;
}

.provider-editor__model header button:hover {
  color: var(--nox-status-danger);
}

.provider-editor__model > p {
  margin: 0;
}

.provider-editor__modalities {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-2) var(--nox-space-4);
  padding: var(--nox-space-3) 0 0;
  border: 0;
  border-top: 1px solid var(--nox-border-subtle);
  margin: 0;
}

.provider-editor__modalities legend,
.provider-editor__modalities label,
.provider-editor__modalities small {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.provider-editor__modalities legend {
  width: 100%;
  padding: 0 0 var(--nox-space-2);
  color: var(--nox-text-secondary);
}

.provider-editor__modalities label {
  display: inline-flex;
  align-items: center;
  gap: var(--nox-space-2);
  text-transform: capitalize;
}

.provider-editor__modalities small,
.provider-editor__modalities .provider-editor__error {
  width: 100%;
}

.provider-editor__add-model {
  min-height: var(--nox-control-height);
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-secondary);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  cursor: pointer;
}

.provider-editor__add-model:hover {
  border-color: var(--nox-action-primary);
  color: var(--nox-action-primary);
  background: var(--nox-surface-hover);
}

.provider-editor__advanced-group {
  border-top: 1px solid var(--nox-border-subtle);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-surface-1) 70%, transparent);
}

.provider-editor__advanced-group summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
  cursor: pointer;
  list-style: none;
}

.provider-editor__advanced-group summary::-webkit-details-marker {
  display: none;
}

.provider-editor__advanced-group summary span,
.provider-editor__advanced-group summary small {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.provider-editor__advanced-group summary strong {
  font-size: var(--nox-text-sm);
}

.provider-editor__advanced-group summary::after {
  color: var(--nox-action-primary);
  content: '+';
  font-family: var(--nox-font-mono);
}

.provider-editor__advanced-group[open] summary::after {
  content: '−';
}

.provider-editor__retry-grid {
  padding: 0 var(--nox-space-5) var(--nox-space-5);
}

.provider-editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.provider-editor__json-field > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.provider-editor__json-field button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.provider-editor__json-field textarea {
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

.provider-editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.provider-editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.provider-editor__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.provider-editor__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.provider-editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.provider-editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.provider-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 60rem) {
  .provider-editor__header,
  .provider-editor__content,
  .provider-editor__actions {
    padding-right: var(--nox-space-5);
    padding-left: var(--nox-space-5);
  }

  .provider-editor__section,
  .provider-editor__json {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 36rem) {
  .provider-editor__header,
  .provider-editor__actions,
  .provider-editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .provider-editor__header-side {
    justify-items: start;
  }

  .provider-editor__badges,
  .provider-editor__modes {
    justify-content: flex-start;
  }

  .provider-editor__field-grid,
  .provider-editor__retry-grid {
    grid-template-columns: 1fr;
  }

  .provider-editor__secret-status {
    grid-template-columns: 1fr;
  }

  .provider-editor__advanced-group summary {
    grid-template-columns: 1fr auto;
  }

  .provider-editor__advanced-group summary span,
  .provider-editor__advanced-group summary small {
    grid-column: 1 / -1;
  }
}
</style>
