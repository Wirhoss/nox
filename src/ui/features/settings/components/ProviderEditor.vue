<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { NEW_SECRET } from '../model/managedSecrets'
import { activeFields, defaultsFor, formNodes, isObject, seedNode, valueAt, variantAt, withValueAt } from '../model/schemaForm'
import { useSettingsStore } from '../stores/settings.store'
import SchemaFieldGroup from './SchemaFieldGroup.vue'

import type { ConfigSection } from '../api/settings.api'
import type { CredentialState } from '../model/managedSecrets'
import type { ConfigLike, FieldNode, FormNode } from '../model/schemaForm'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  presetType?: string
  section: ConfigSection
}

const FRAMED = ['type']
const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
  presetType: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { plural, t } = useI18n()

const mode = ref<EditorMode>('form')
const draft = ref<ConfigLike>({})
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const jsonError = ref<string>()
const confirmingDelete = ref(false)
const credentials = reactive<Record<string, CredentialState>>({})

/** Generic creation is only for operator-named, many-instance contributions. */
const types = computed(() =>
  props.creating && props.presetType === undefined
    ? settings.contributionTypes.filter((candidate) => candidate.instances === 'many')
    : settings.contributionTypes,
)
const descriptor = computed(() =>
  types.value.find((candidate) => candidate.type === draft.value.type),
)
const nodes = computed<readonly FormNode[]>(() =>
  descriptor.value === undefined ? [] : formNodes(descriptor.value.schema, FRAMED),
)
const selectedValue = computed<ConfigLike>(() => {
  if (props.creating || props.entryId === undefined) return newTemplate()
  const value = props.section.value[props.entryId]
  return isObject(value) ? value : newTemplate()
})
/** The section names itself: this editor serves every contributed section. */
const entryName = computed(() => t(props.definition.label))
const title = computed(() =>
  props.creating
    ? t('settings.navigation.newEntry', { entry: entryName.value })
    : (props.entryId ?? entryName.value),
)
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    if (parsed === undefined) return true
    return JSON.stringify(parsed) !== originalJsonSignature.value || credentialInputsDirty()
  }
  return formSignature() !== originalSignature.value
})

/**
 * The provider this form is about, where it is about one. Only a saved entry
 * has an activated instance behind it, and only an instance can report what it
 * serves — so a provider being created has nothing to offer yet, and says so
 * rather than pretending the endpoint returned an empty list.
 */
const editedProviderId = computed(() =>
  props.section.key === 'providers' && !props.creating ? props.entryId : undefined,
)

/** What the model fields in this form can currently offer, and why. */
const modelCatalogSummary = computed(() => {
  const provider = settings.providerInventory.find(
    (candidate) => candidate.id === editedProviderId.value,
  )
  if (provider === undefined) return t('settings.catalog.notActivated')
  if (!provider.available) {
    return t('settings.catalog.providerProblem', {
      problem: provider.problem ?? t('settings.catalog.providerUnavailable'),
    })
  }
  if (!provider.reported) {
    return t('settings.catalog.modelsUnlistable', {
      problem: provider.reportProblem ?? t('settings.catalog.noModelList'),
    })
  }
  return plural('settings.catalog.reportedCount', provider.models.length)
})

watch(
  [() => props.creating, () => props.entryId, selectedValue, types],
  () => {
    resetEditor()
  },
  { immediate: true },
)

function newTemplate(): ConfigLike {
  const selectedType = props.presetType ?? types.value[0]?.type
  const selected = types.value.find((candidate) => candidate.type === selectedType)
  if (selected === undefined) return { type: selectedType ?? '' }
  return { ...defaultsFor(formNodes(selected.schema, FRAMED)), type: selected.type }
}

function resetEditor(): void {
  draft.value = clone(selectedValue.value)
  if (props.creating && props.presetType !== undefined) draft.value.type = props.presetType
  mode.value = descriptor.value === undefined ? 'json' : 'form'
  entryIdInput.value = props.creating ? (props.presetType ?? '') : ''
  fieldErrors.value = {}
  jsonError.value = undefined
  confirmingDelete.value = false
  syncCredentials()
  jsonSource.value = JSON.stringify(editableConfig(draft.value), undefined, 2)
  originalJsonSignature.value = JSON.stringify(draft.value)
  originalSignature.value = formSignature()
}

function formSignature(): string {
  return JSON.stringify({ credentials, draft: draft.value, entryId: entryIdInput.value })
}

function setType(type: string): void {
  const selected = types.value.find((candidate) => candidate.type === type)
  draft.value =
    selected === undefined
      ? { type }
      : { ...defaultsFor(formNodes(selected.schema, FRAMED)), type: selected.type }
  syncCredentials()
  clearFeedback('type')
}

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

function syncCredentials(): void {
  for (const key of Object.keys(credentials)) Reflect.deleteProperty(credentials, key)
  for (const node of activeFields(nodes.value, draft.value)) {
    if (node.control !== 'secret') continue
    credentials[node.path.join('.')] = { newId: '', selection: secretIdAt(node), value: '' }
  }
}

function secretIdAt(node: FieldNode): string {
  const current = valueAt(draft.value, node.path)
  return isObject(current) && typeof current.$secret === 'string' ? current.$secret : ''
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
  const nextDescriptor = types.value.find((candidate) => candidate.type === parsed.type)
  if (nextDescriptor === undefined) {
    jsonError.value = t('settings.editor.curatedFormUnavailable')
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

function collectSecretWrites():
  readonly { readonly secretId: string; readonly value: string }[] | undefined {
  const writes = new Map<string, string>()
  for (const [key, state] of Object.entries(credentials)) {
    if (state.value.length === 0) continue
    const secretId = state.selection === NEW_SECRET ? state.newId.trim() : state.selection
    if (!validSecretId(secretId)) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`${key}.secretId`]: t('settings.toolSet.validation.chooseSecretId'),
      }
      return undefined
    }
    const duplicate = writes.get(secretId)
    if (duplicate !== undefined && duplicate !== state.value) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`${key}.secretValue`]: t('settings.toolSet.validation.conflictingSecretValues'),
      }
      return undefined
    }
    writes.set(secretId, state.value)
  }
  return [...writes].map(([secretId, value]) => ({ secretId, value }))
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (descriptor.value === undefined) errors.type = t('settings.toolSet.validation.useJson')
  if (props.creating && !validEntryId(entryIdInput.value.trim())) {
    errors.entryId = t('settings.validation.entryId')
  }
  for (const node of activeFields(nodes.value, draft.value)) validateField(node, errors)
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateField(node: FieldNode, errors: Record<string, string>): void {
  const key = node.path.join('.')
  const value = valueAt(draft.value, node.path)
  if (node.control === 'secret') {
    const state = credentials[key]
    if (state?.selection === NEW_SECRET) {
      if (!validSecretId(state.newId.trim()))
        errors[`${key}.secretId`] = t('settings.validation.secretId')
      if (state.value.length === 0) {
        errors[`${key}.secretValue`] = t('settings.toolSet.validation.secretValueRequired')
      }
    }
    if (node.required && value === undefined)
      errors[key] = t('settings.toolSet.validation.required')
    return
  }
  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    if (node.required) errors[key] = t('settings.toolSet.validation.required')
    return
  }
  if (node.url && !(typeof value === 'string' && validHttpUrl(value))) {
    errors[key] = t('settings.toolSet.validation.httpUrl')
    return
  }
  if (node.control !== 'number') return
  if (typeof value !== 'number' || (node.integer && !Number.isInteger(value))) {
    errors[key] = t(node.integer ? 'settings.validation.integer' : 'settings.validation.number')
    return
  }
  if (node.minimum !== undefined && value < node.minimum) {
    errors[key] = t('settings.validation.numberMinimum', { minimum: node.minimum })
  } else if (node.maximum !== undefined && value > node.maximum) {
    errors[key] = t('settings.validation.numberRange', {
      maximum: node.maximum,
      minimum: node.minimum ?? 0,
    })
  }
}

function parseJson(report: boolean): ConfigLike | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isObject(parsed)) {
      if (report) jsonError.value = t('settings.validation.configurationObject')
      return undefined
    }
    if (report) jsonError.value = undefined
    return { ...editableConfig(parsed), type: draft.value.type }
  } catch {
    if (report) jsonError.value = t('settings.validation.invalidJson')
    return undefined
  }
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

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

function credentialInputsDirty(): boolean {
  return Object.values(credentials).some(
    (state) => state.value.length > 0 || state.newId.length > 0,
  )
}

function canLeave(): boolean {
  return !dirty.value || window.confirm(t('settings.confirm.discardConfiguration'))
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
  <article class="contribution-editor">
    <header class="contribution-editor__header">
      <div>
        <p>
          {{ t(props.definition.plural).toUpperCase() }} //
          {{ props.entryId?.toUpperCase() ?? t('common.new').toUpperCase() }}
        </p>
        <h2>{{ title }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="contribution-editor__header-side">
        <div class="contribution-editor__badges">
          <span>{{ props.section.name }}</span>
          <span>{{ String(draft.type || t('common.missing')) }}</span>
          <span>{{ t('settings.editor.hotApply') }}</span>
        </div>
        <div class="contribution-editor__modes" :aria-label="t('settings.editor.mode')">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            {{ t('settings.editor.form') }}
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            {{ t('settings.editor.json') }}
          </button>
        </div>
      </div>
    </header>

    <div class="contribution-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.editor.saved')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>
          {{
            t(
              settings.mutation.restartRequired
                ? 'settings.editor.savedRestart'
                : 'settings.editor.savedImmediate',
            )
          }}
        </p>
      </NoxNotice>
      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="t('settings.editor.changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating && props.presetType === undefined"
        id="provider-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        :hint="t('settings.editor.entryIdHint')"
        :label="t('settings.editor.entryId')"
        placeholder="main"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section
          v-if="props.creating && props.presetType === undefined"
          class="contribution-editor__section"
        >
          <div class="contribution-editor__section-copy">
            <p>01 // {{ t('common.contributed') }}</p>
            <h3>{{ entryName }}</h3>
            <span>{{ t(props.definition.description) }}</span>
          </div>
          <div
            class="contribution-editor__field"
            :class="{ 'contribution-editor__field--invalid': fieldErrors.type }"
          >
            <label for="provider-type"
              >{{ t('settings.toolSet.surface') }}
              <small>{{ t('common.requiredShort') }}</small></label
            >
            <select
              id="provider-type"
              :value="String(draft.type ?? '')"
              @change="setType(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="candidate in types" :key="candidate.type" :value="candidate.type">
                {{ candidate.type }}
              </option>
            </select>
            <p v-if="fieldErrors.type" class="contribution-editor__error">{{ fieldErrors.type }}</p>
          </div>
        </section>

        <section class="contribution-editor__section">
          <div class="contribution-editor__section-copy">
            <p>{{ t('settings.toolSet.configured') }}</p>
            <h3>{{ t('settings.editor.metadata') }}</h3>
            <span>{{ t('settings.editor.configurationJsonHelp') }}</span>
          </div>
          <SchemaFieldGroup
            v-if="descriptor"
            :credentials="credentials"
            :errors="fieldErrors"
            :extension-id="descriptor.extensionId"
            :nodes="nodes"
            :provider-inventory="settings.providerInventory"
            :provider-id="editedProviderId"
            :secrets="settings.secrets"
            :value="draft"
            @credential="applyCredential"
            @update="applyUpdate"
          />
          <div v-if="editedProviderId !== undefined" class="contribution-editor__catalog">
            <p>{{ modelCatalogSummary }}</p>
            <button type="button" @click="settings.refreshProviderInventory()">
              {{ t('settings.catalog.refresh') }}
            </button>
          </div>
        </section>
      </template>

      <section v-else class="contribution-editor__section">
        <div class="contribution-editor__section-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3>{{ t('settings.editor.configurationJson') }}</h3>
          <span>{{ t('settings.editor.configurationJsonHelp') }}</span>
        </div>
        <div class="contribution-editor__json-field">
          <div>
            <label for="provider-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatJson()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="provider-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="contribution-editor__error">{{ jsonError }}</p>
        </div>
      </section>

      <NoxNotice
        v-if="confirmingDelete"
        :title="t('settings.editor.removeEntryQuestion')"
        tone="danger"
      >
        <div class="contribution-editor__delete-confirmation">
          <p>{{ t('settings.editor.removeEntryReference', { entry: props.entryId ?? '' }) }}</p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">{{
              t('common.cancel')
            }}</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">{{
              t('settings.editor.removeEntry')
            }}</NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="contribution-editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        {{ t('settings.editor.removeNamed', { entry: entryName }) }}
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="contribution-editor__dirty">{{
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
          {{ t('settings.editor.saveChanges') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.contribution-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.contribution-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.contribution-editor__header p,
.contribution-editor__header span,
.contribution-editor__section-copy p,
.contribution-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.contribution-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
}

.contribution-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.contribution-editor__badges,
.contribution-editor__modes,
.contribution-editor__actions > div,
.contribution-editor__delete-confirmation > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nox-space-2);
}

.contribution-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.contribution-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.contribution-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  cursor: pointer;
}

.contribution-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.contribution-editor__content {
  display: grid;
  width: min(100%, 68rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.contribution-editor__section {
  display: grid;
  grid-template-columns: minmax(13rem, 0.36fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-block: 1px solid var(--nox-border-subtle);
}

.contribution-editor__section + .contribution-editor__section {
  border-top: 0;
}

.contribution-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
}

.contribution-editor__section-copy span {
  display: block;
  line-height: 1.65;
}

.contribution-editor__field,
.contribution-editor__json-field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.contribution-editor__field label,
.contribution-editor__json-field label {
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  text-transform: uppercase;
}

.contribution-editor__field select {
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.contribution-editor__json-field > div {
  display: flex;
  justify-content: space-between;
}

.contribution-editor__json-field button {
  color: var(--nox-action-primary);
  background: transparent;
  font-family: var(--nox-font-mono);
  cursor: pointer;
}

.contribution-editor__json-field textarea {
  min-height: 28rem;
  padding: var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-code-text);
  background: var(--nox-code-surface);
  font-family: var(--nox-font-mono);
  line-height: 1.65;
  resize: vertical;
}

.contribution-editor__catalog {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  margin-top: var(--nox-space-4);
}

.contribution-editor__catalog p {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.contribution-editor__catalog button {
  color: var(--nox-action-primary);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.contribution-editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.contribution-editor__delete-confirmation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-5);
}

.contribution-editor__actions {
  position: sticky;
  bottom: 0;
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 94%, transparent);
}

.contribution-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

@media (max-width: 48rem) {
  .contribution-editor__header,
  .contribution-editor__actions,
  .contribution-editor__delete-confirmation {
    align-items: stretch;
    flex-direction: column;
  }

  .contribution-editor__header-side {
    justify-items: start;
  }

  .contribution-editor__section {
    grid-template-columns: 1fr;
  }

  .contribution-editor__content,
  .contribution-editor__header,
  .contribution-editor__actions {
    padding-inline: var(--nox-space-5);
  }
}
</style>
