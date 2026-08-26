<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { useSettingsStore } from '../stores/settings.store'

import type { ConfigSection, ConfigValue } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'

interface BrokerCommonDraft {
  agent: string
  enabled: boolean
  type: string
}

interface ConversationDraft {
  agent: string
  conversationId: string
  extra: ConfigValue
  grants: PrincipalGrantDraft[]
}

/** A value the operator typed for one reference, keyed by where it was named. */
interface PendingSecret {
  secretId: string
  value: string
}

interface PrincipalGrantDraft {
  patterns: string[]
  subject: string
}

/** One place this broker's configuration names a secret. */
interface SecretReferenceDraft {
  path: string
  secretId: string
}

interface Props {
  blueprintSection?: ConfigSection
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  section: ConfigSection
}

const COMMON_PROPERTIES = new Set([
  'agent',
  'approvers',
  'conversations',
  'enabled',
  'grants',
  'type',
])
const AUTHORITY_SUGGESTIONS = Object.freeze([
  '*',
  'nox.history.*',
  'nox.history.read',
  'nox.history.search',
  'nox.tools.search',
  'nox.toolset.web.*',
  'nox.toolset.web.extract',
  'nox.toolset.web.search',
])
const props = withDefaults(defineProps<Props>(), {
  blueprintSection: undefined,
  creating: false,
  entryId: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { t } = useI18n()
const mode = ref<EditorMode>('form')
const common = ref<BrokerCommonDraft>(newCommonTemplate())
const baseGrants = ref<PrincipalGrantDraft[]>([])
const conversations = ref<ConversationDraft[]>([])
const transportJsonSource = ref('{}')
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const transportJsonError = ref<string>()
const jsonError = ref<string>()
const confirmingDelete = ref(false)
const pendingSecrets = ref<Readonly<Record<string, PendingSecret>>>({})
const selectedValue = computed<ConfigValue>(() => {
  if (props.creating || props.entryId === undefined) return newBrokerTemplate()
  const value = props.section.value[props.entryId]
  return isConfigValue(value) ? value : newBrokerTemplate()
})
const agents = computed(() => Object.keys(props.blueprintSection?.value ?? {}))
const isWeb = computed(() => common.value.type === 'web' && props.entryId === 'web')
const title = computed(() =>
  props.creating
    ? t('settings.broker.titleNew')
    : (props.entryId ?? t('settings.broker.titleFallback')),
)
const sourceName = computed(() => props.section.name)
const currentValue = computed<ConfigValue | undefined>(() =>
  mode.value === 'json' ? parseJson(false) : buildFormValue(false),
)
/**
 * A broker's transport fields are free-form contributed configuration, so the
 * credentials it names are found by looking rather than by knowing: whatever
 * survived the schema as a reference is one, wherever it sits.
 */
const secretReferences = computed<readonly SecretReferenceDraft[]>(() =>
  currentValue.value === undefined ? [] : findSecretReferences(currentValue.value),
)
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    if (parsed === undefined) return true
    return JSON.stringify(parsed) !== originalJsonSignature.value || pendingSecretsDirty()
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
  hydrate(selectedValue.value)
  mode.value = 'form'
  entryIdInput.value = ''
  fieldErrors.value = {}
  transportJsonError.value = undefined
  jsonError.value = undefined
  confirmingDelete.value = false
  pendingSecrets.value = {}
  jsonSource.value = JSON.stringify(editableBrokerConfig(selectedValue.value), undefined, 2)
  originalJsonSignature.value = JSON.stringify(selectedValue.value)
  originalSignature.value = formSignature()
}

function hydrate(value: ConfigValue): void {
  common.value = {
    agent: stringValue(value.agent),
    enabled: value.enabled !== false,
    type: stringValue(value.type),
  }
  baseGrants.value = grantDrafts(value.grants)
  conversations.value = conversationDrafts(value.conversations)
  transportJsonSource.value = JSON.stringify(transportPayload(value), undefined, 2)
}

function formSignature(): string {
  return JSON.stringify({
    baseGrants: baseGrants.value,
    common: common.value,
    conversations: conversations.value,
    entryId: entryIdInput.value,
    pendingSecrets: activePendingSecrets(),
    transport: transportJsonSource.value,
  })
}

function setCommon(field: 'agent', value: string): void {
  common.value = { ...common.value, [field]: value }
  clearFeedback(field)
}

function setEnabled(value: boolean): void {
  common.value = { ...common.value, enabled: value }
  clearFeedback('enabled')
}

function grantList(conversationIndex?: number): PrincipalGrantDraft[] | undefined {
  return conversationIndex === undefined
    ? baseGrants.value
    : conversations.value[conversationIndex]?.grants
}

function replaceGrantList(next: PrincipalGrantDraft[], conversationIndex?: number): void {
  if (conversationIndex === undefined) {
    baseGrants.value = next
    return
  }
  const conversation = conversations.value[conversationIndex]
  if (conversation === undefined) return
  conversations.value = conversations.value.map((candidate, index) =>
    index === conversationIndex ? { ...candidate, grants: next } : candidate,
  )
}

function addPrincipal(conversationIndex?: number): void {
  const grants = grantList(conversationIndex)
  if (grants === undefined) return
  replaceGrantList([...grants, { patterns: [''], subject: '' }], conversationIndex)
  settings.clearMutation()
}

function removePrincipal(principalIndex: number, conversationIndex?: number): void {
  const grants = grantList(conversationIndex)
  if (grants === undefined) return
  replaceGrantList(
    grants.filter((_, index) => index !== principalIndex),
    conversationIndex,
  )
  settings.clearMutation()
}

function setPrincipalSubject(
  principalIndex: number,
  value: string,
  conversationIndex?: number,
): void {
  const grants = grantList(conversationIndex)
  if (grants === undefined) return
  replaceGrantList(
    grants.map((principal, index) =>
      index === principalIndex ? { ...principal, subject: value } : principal,
    ),
    conversationIndex,
  )
  clearFeedback(grantErrorPrefix(principalIndex, conversationIndex, 'subject'))
}

function addPattern(principalIndex: number, conversationIndex?: number): void {
  const grants = grantList(conversationIndex)
  const principal = grants?.[principalIndex]
  if (grants === undefined || principal === undefined) return
  replaceGrantList(
    grants.map((candidate, index) =>
      index === principalIndex
        ? { ...candidate, patterns: [...candidate.patterns, ''] }
        : candidate,
    ),
    conversationIndex,
  )
  settings.clearMutation()
}

function setPattern(
  principalIndex: number,
  patternIndex: number,
  value: string,
  conversationIndex?: number,
): void {
  const grants = grantList(conversationIndex)
  if (grants === undefined) return
  replaceGrantList(
    grants.map((principal, index) =>
      index === principalIndex
        ? {
            ...principal,
            patterns: principal.patterns.map((pattern, candidateIndex) =>
              candidateIndex === patternIndex ? value : pattern,
            ),
          }
        : principal,
    ),
    conversationIndex,
  )
  clearFeedback(
    grantErrorPrefix(principalIndex, conversationIndex, `pattern.${String(patternIndex)}`),
  )
}

function removePattern(
  principalIndex: number,
  patternIndex: number,
  conversationIndex?: number,
): void {
  const grants = grantList(conversationIndex)
  if (grants === undefined) return
  replaceGrantList(
    grants.map((principal, index) =>
      index === principalIndex
        ? {
            ...principal,
            patterns: principal.patterns.filter(
              (_, candidateIndex) => candidateIndex !== patternIndex,
            ),
          }
        : principal,
    ),
    conversationIndex,
  )
  settings.clearMutation()
}

function grantErrorPrefix(
  principalIndex: number,
  conversationIndex: number | undefined,
  field: string,
): string {
  return conversationIndex === undefined
    ? `grant.${String(principalIndex)}.${field}`
    : `conversation.${String(conversationIndex)}.grant.${String(principalIndex)}.${field}`
}

function addConversation(): void {
  conversations.value = [
    ...conversations.value,
    { agent: '', conversationId: '', extra: {}, grants: [] },
  ]
  settings.clearMutation()
}

function removeConversation(index: number): void {
  conversations.value = conversations.value.filter((_, candidateIndex) => candidateIndex !== index)
  settings.clearMutation()
}

function setConversationField(
  index: number,
  field: 'agent' | 'conversationId',
  value: string,
): void {
  conversations.value = conversations.value.map((conversation, candidateIndex) =>
    candidateIndex === index ? { ...conversation, [field]: value } : conversation,
  )
  clearFeedback(`conversation.${String(index)}.${field}`)
}

function setPendingSecret(reference: SecretReferenceDraft, value: string): void {
  pendingSecrets.value = {
    ...pendingSecrets.value,
    [reference.path]: { secretId: reference.secretId, value },
  }
  clearFeedback(`secret.${reference.path}`)
}

/** Keyed by path and checked against the ID, so editing the reference drops a stale value. */
function pendingSecretValue(reference: SecretReferenceDraft): string {
  const pending = pendingSecrets.value[reference.path]
  return pending?.secretId === reference.secretId ? pending.value : ''
}

function secretStored(secretId: string): boolean {
  return settings.secrets.some((secret) => secret.secretId === secretId && secret.stored)
}

function switchMode(nextMode: EditorMode): void {
  if (mode.value === nextMode) return
  if (nextMode === 'json') {
    const value = buildFormValue(true)
    if (value === undefined) return
    jsonSource.value = JSON.stringify(editableBrokerConfig(value), undefined, 2)
    jsonError.value = undefined
    mode.value = nextMode
    return
  }

  const parsed = parseJson(true)
  if (parsed === undefined) return
  hydrate(parsed)
  mode.value = nextMode
}

function formatJson(): void {
  const parsed = parseJson(true)
  if (parsed !== undefined) {
    jsonSource.value = JSON.stringify(editableBrokerConfig(parsed), undefined, 2)
  }
}

function formatTransportJson(): void {
  const parsed = parseTransportJson(true)
  if (parsed !== undefined) transportJsonSource.value = JSON.stringify(parsed, undefined, 2)
}

async function save(): Promise<void> {
  fieldErrors.value = {}
  jsonError.value = undefined
  transportJsonError.value = undefined
  let value: ConfigValue
  if (mode.value === 'json') {
    const parsed = parseJson(true)
    if (parsed === undefined) return
    value = parsed
  } else {
    const built = buildFormValue(true)
    if (built === undefined || !validateForm()) return
    value = built
  }

  const nextEntryId = props.creating ? entryIdInput.value.trim() : props.entryId
  if (nextEntryId === undefined || !validEntryId(nextEntryId)) {
    fieldErrors.value = {
      ...fieldErrors.value,
      entryId: t('settings.validation.entryId'),
    }
    return
  }
  if (props.creating && nextEntryId === 'web') {
    fieldErrors.value = {
      ...fieldErrors.value,
      entryId: t('settings.broker.validation.webReserved'),
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
 * The credentials to write with this entry, or `undefined` when the inputs
 * cannot be honoured.
 *
 * An enabled broker with an unstored credential is refused rather than saved:
 * unlike a provider's optional key, a transport that needs a token cannot
 * connect without one, and saving would request a broker generation that fails
 * for a reason this form already knew.
 */
function collectSecretWrites(
  value: ConfigValue,
): readonly { readonly secretId: string; readonly value: string }[] | undefined {
  const references = findSecretReferences(value)
  const writes = new Map<string, string>()
  for (const reference of references) {
    const pendingValue = pendingSecretValue(reference)
    if (!validSecretId(reference.secretId)) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`secret.${reference.path}`]: t('settings.broker.validation.invalidSecretId'),
      }
      return undefined
    }
    if (pendingValue.length === 0) continue
    const duplicate = writes.get(reference.secretId)
    if (duplicate !== undefined && duplicate !== pendingValue) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`secret.${reference.path}`]: t('settings.broker.validation.conflictingSecretValues'),
      }
      return undefined
    }
    writes.set(reference.secretId, pendingValue)
  }

  if (commonEnabled(value)) {
    const missing = references.find(
      (reference) => !secretStored(reference.secretId) && !writes.has(reference.secretId),
    )
    if (missing !== undefined) {
      fieldErrors.value = {
        ...fieldErrors.value,
        [`secret.${missing.path}`]: t('settings.broker.validation.storeBeforeEnabling'),
      }
      return undefined
    }
  }
  return [...writes].map(([secretId, secretValue]) => ({ secretId, value: secretValue }))
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (!isWeb.value && common.value.agent.trim().length === 0) {
    errors.agent = t('settings.broker.validation.baseAgentRequired')
  } else if (
    common.value.agent.trim().length > 0 &&
    common.value.enabled &&
    !agents.value.includes(common.value.agent)
  ) {
    errors.agent = t('settings.broker.validation.agentAvailable')
  }
  if (props.creating && !validEntryId(entryIdInput.value.trim())) {
    errors.entryId = t('settings.validation.entryId')
  }
  if (props.creating && entryIdInput.value.trim() === 'web') {
    errors.entryId = t('settings.broker.validation.webReserved')
  }

  if (!isWeb.value) validateGrantList(baseGrants.value, errors)
  const conversationIds = new Set<string>()
  conversations.value.forEach((conversation, index) => {
    const prefix = `conversation.${String(index)}`
    const id = conversation.conversationId.trim()
    if (id.length === 0) {
      errors[`${prefix}.conversationId`] = t('settings.broker.validation.conversationIdRequired')
    } else if (conversationIds.has(id)) {
      errors[`${prefix}.conversationId`] = t('settings.broker.validation.conversationIdUnique')
    }
    conversationIds.add(id)
    if (
      common.value.enabled &&
      conversation.agent.length > 0 &&
      !agents.value.includes(conversation.agent)
    ) {
      errors[`${prefix}.agent`] = t('settings.broker.validation.agentAvailable')
    }
    if (!isWeb.value) validateGrantList(conversation.grants, errors, index)
  })

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateGrantList(
  grants: readonly PrincipalGrantDraft[],
  errors: Record<string, string>,
  conversationIndex?: number,
): void {
  const subjects = new Set<string>()
  grants.forEach((principal, principalIndex) => {
    const subject = principal.subject.trim()
    const subjectError = grantErrorPrefix(principalIndex, conversationIndex, 'subject')
    if (subject.length === 0) {
      errors[subjectError] = t('settings.broker.validation.senderIdRequired')
    } else if (subjects.has(subject)) {
      errors[subjectError] = t('settings.broker.validation.senderIdUnique')
    }
    subjects.add(subject)

    const patterns = new Set<string>()
    principal.patterns.forEach((pattern, patternIndex) => {
      const normalized = pattern.trim()
      const patternError = grantErrorPrefix(
        principalIndex,
        conversationIndex,
        `pattern.${String(patternIndex)}`,
      )
      if (!validGrantPattern(normalized)) {
        errors[patternError] = t('settings.broker.validation.authorityPattern')
      } else if (patterns.has(normalized)) {
        errors[patternError] = t('settings.broker.validation.grantUnique')
      }
      patterns.add(normalized)
    })
  })
}

function buildFormValue(report: boolean): ConfigValue | undefined {
  const payload = parseTransportJson(report)
  if (payload === undefined) return undefined
  return {
    ...payload,
    ...(common.value.agent.trim().length === 0 ? {} : { agent: common.value.agent.trim() }),
    conversations: Object.fromEntries(
      conversations.value.map((conversation) => [
        conversation.conversationId.trim(),
        {
          ...conversation.extra,
          ...(conversation.agent.length === 0 ? {} : { agent: conversation.agent }),
          grants: isWeb.value ? {} : grantsRecord(conversation.grants),
        },
      ]),
    ),
    enabled: common.value.enabled,
    grants: isWeb.value ? {} : grantsRecord(baseGrants.value),
    type: common.value.type.trim(),
  }
}

function grantsRecord(grants: readonly PrincipalGrantDraft[]): ConfigValue {
  return Object.fromEntries(
    grants.map((principal) => [
      principal.subject.trim(),
      principal.patterns.map((pattern) => pattern.trim()),
    ]),
  )
}

function parseTransportJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(transportJsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) transportJsonError.value = t('settings.broker.validation.payloadObject')
      return undefined
    }
    if (report) transportJsonError.value = undefined
    return parsed
  } catch {
    if (report) transportJsonError.value = t('settings.broker.validation.payloadJson')
    return undefined
  }
}

function parseJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) jsonError.value = t('settings.broker.validation.configurationObject')
      return undefined
    }
    if (report) jsonError.value = undefined
    return { ...editableBrokerConfig(parsed), type: common.value.type }
  } catch {
    if (report) jsonError.value = t('settings.validation.invalidJson')
    return undefined
  }
}

function pendingSecretsDirty(): boolean {
  return Object.keys(activePendingSecrets()).length > 0
}

/** Only the values that still belong to a reference this configuration names. */
function activePendingSecrets(): Readonly<Record<string, PendingSecret>> {
  const references = new Map(
    secretReferences.value.map((reference) => [reference.path, reference.secretId]),
  )
  return Object.fromEntries(
    Object.entries(pendingSecrets.value).filter(
      ([path, pending]) => pending.value.length > 0 && references.get(path) === pending.secretId,
    ),
  )
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
  return !dirty.value || window.confirm(t('settings.confirm.discardBroker'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function newCommonTemplate(): BrokerCommonDraft {
  return { agent: '', enabled: true, type: '' }
}

function newBrokerTemplate(): ConfigValue {
  return { agent: '', conversations: {}, enabled: true, grants: {}, type: '' }
}

/** The discriminator selects the contribution's schema; it is metadata, not editable config. */
function editableBrokerConfig(value: ConfigValue): ConfigValue {
  return withoutProperty(value, 'type')
}

function transportPayload(value: ConfigValue): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !COMMON_PROPERTIES.has(key)))
}

function grantDrafts(value: unknown): PrincipalGrantDraft[] {
  if (!isConfigValue(value)) return []
  return Object.entries(value).flatMap(([subject, patterns]): PrincipalGrantDraft[] =>
    Array.isArray(patterns)
      ? [
          {
            patterns: patterns.filter((pattern): pattern is string => typeof pattern === 'string'),
            subject,
          },
        ]
      : [],
  )
}

function conversationDrafts(value: unknown): ConversationDraft[] {
  if (!isConfigValue(value)) return []
  return Object.entries(value).flatMap(([conversationId, candidate]): ConversationDraft[] => {
    if (!isConfigValue(candidate)) return []
    return [
      {
        agent: stringValue(candidate.agent),
        conversationId,
        extra: Object.fromEntries(
          Object.entries(candidate).filter(([key]) => !['agent', 'grants'].includes(key)),
        ),
        grants: grantDrafts(candidate.grants),
      },
    ]
  })
}

function findSecretReferences(value: ConfigValue): SecretReferenceDraft[] {
  const references: SecretReferenceDraft[] = []
  visitSecrets(value, '', references)
  return references.sort((a, b) => a.path.localeCompare(b.path))
}

function visitSecrets(value: unknown, path: string, references: SecretReferenceDraft[]): void {
  if (Array.isArray(value)) {
    value.forEach((candidate, index) => {
      visitSecrets(candidate, `${path}[${String(index)}]`, references)
    })
    return
  }
  if (!isConfigValue(value)) return
  const secretId = stringValue(value.$secret)
  if (secretId.length > 0) {
    references.push({ path: path.replace(/^\./, ''), secretId })
    return
  }
  for (const [key, candidate] of Object.entries(value)) {
    visitSecrets(candidate, `${path}.${key}`, references)
  }
}

function validSecretId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function commonEnabled(value: ConfigValue): boolean {
  return value.enabled !== false
}

function validEntryId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function validGrantPattern(value: string): boolean {
  if (value === '*') return true
  const namespace = value.endsWith('.*') ? value.slice(0, -2) : value
  const segments = namespace.split('.')
  if (!value.endsWith('.*') && segments.length < 2) return false
  return segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment))
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function withoutProperty(value: ConfigValue, property: string): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}
</script>

<template>
  <article class="broker-editor">
    <header class="broker-editor__header">
      <div>
        <p>
          {{ t('settings.broker.header') }} //
          {{ props.entryId?.toUpperCase() ?? t('common.new').toUpperCase() }}
        </p>
        <h2>{{ title }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="broker-editor__header-side">
        <div class="broker-editor__badges">
          <span>{{ sourceName }}</span>
          <span>{{ common.type || t('settings.broker.typeUnset') }}</span>
          <span
            :class="common.enabled ? 'broker-editor__badge--live' : 'broker-editor__badge--held'"
          >
            {{ common.enabled ? t('common.enabled') : t('common.disabled') }}
          </span>
          <span>{{ t('settings.editor.hotApply') }}</span>
        </div>
        <div class="broker-editor__modes" :aria-label="t('settings.editor.mode')">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            {{ t('settings.editor.form') }}
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            {{ t('settings.editor.json') }}
          </button>
        </div>
      </div>
    </header>

    <div class="broker-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.broker.saved')"
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
        :title="t('settings.broker.changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="broker-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        :hint="t('settings.broker.idHint')"
        :label="t('settings.broker.id')"
        placeholder="discord"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section class="broker-editor__section" aria-labelledby="broker-route-title">
          <div class="broker-editor__section-copy">
            <p>01 // {{ t('settings.broker.routing') }}</p>
            <h3 id="broker-route-title">{{ t('settings.broker.transportRoute') }}</h3>
            <span>{{ t('settings.broker.transportRouteHelp') }}</span>
          </div>
          <div class="broker-editor__fields">
            <div
              class="broker-editor__field"
              :class="{ 'broker-editor__field--invalid': fieldErrors.agent }"
            >
              <label for="broker-agent"
                >{{ t('settings.broker.baseAgent') }}
                <small v-if="!isWeb">{{ t('common.requiredShort') }}</small></label
              >
              <select
                id="broker-agent"
                :value="common.agent"
                :aria-invalid="fieldErrors.agent !== undefined"
                @change="setCommon('agent', ($event.target as HTMLSelectElement).value)"
              >
                <option value="" :disabled="!isWeb">
                  {{
                    isWeb
                      ? t('settings.broker.askAgentOnNewConversation')
                      : t('settings.broker.selectAgent')
                  }}
                </option>
                <option v-for="agentId in agents" :key="agentId" :value="agentId">
                  {{ agentId }}
                </option>
                <option v-if="common.agent && !agents.includes(common.agent)" :value="common.agent">
                  {{ common.agent }} · {{ t('common.missing') }}
                </option>
              </select>
              <p v-if="fieldErrors.agent" class="broker-editor__error">{{ fieldErrors.agent }}</p>
            </div>
            <label class="broker-editor__enable">
              <input
                type="checkbox"
                :checked="common.enabled"
                @change="setEnabled(($event.target as HTMLInputElement).checked)"
              />
              <span>
                <strong>{{ t('settings.broker.composeOnRestart') }}</strong>
                <small>{{ t('settings.broker.composeOnRestartHelp') }}</small>
              </span>
              <em>{{ common.enabled ? t('common.enabled') : t('settings.broker.held') }}</em>
            </label>
          </div>
        </section>

        <section v-if="!isWeb" class="broker-editor__section" aria-labelledby="broker-grants-title">
          <div class="broker-editor__section-copy">
            <p>02 // {{ t('settings.broker.authorization') }}</p>
            <h3 id="broker-grants-title">{{ t('settings.broker.baseGrants') }}</h3>
            <span>{{ t('settings.broker.baseGrantsHelp') }}</span>
          </div>
          <div class="broker-editor__grant-surface">
            <article
              v-for="(principal, principalIndex) in baseGrants"
              :key="principalIndex"
              class="broker-editor__principal"
            >
              <header>
                <span
                  >{{ t('settings.broker.principal') }} //
                  {{ String(principalIndex + 1).padStart(2, '0') }}</span
                >
                <button type="button" @click="removePrincipal(principalIndex)">
                  {{ t('common.remove') }}
                </button>
              </header>
              <NoxTextField
                :id="`broker-principal-${String(principalIndex)}`"
                :model-value="principal.subject"
                :error="fieldErrors[`grant.${String(principalIndex)}.subject`]"
                :hint="t('settings.broker.senderIdHint')"
                :label="t('settings.broker.senderId')"
                placeholder="sender-id"
                required
                @update:model-value="setPrincipalSubject(principalIndex, $event)"
              />
              <div class="broker-editor__patterns">
                <div v-for="(pattern, patternIndex) in principal.patterns" :key="patternIndex">
                  <NoxTextField
                    :id="`broker-principal-${String(principalIndex)}-pattern-${String(patternIndex)}`"
                    :model-value="pattern"
                    :error="
                      fieldErrors[`grant.${String(principalIndex)}.pattern.${String(patternIndex)}`]
                    "
                    :label="t('settings.broker.authorityPattern')"
                    list="broker-authority-suggestions"
                    placeholder="nox.history.read"
                    required
                    @update:model-value="setPattern(principalIndex, patternIndex, $event)"
                  />
                  <button type="button" @click="removePattern(principalIndex, patternIndex)">
                    ×
                  </button>
                </div>
                <button type="button" @click="addPattern(principalIndex)">
                  + {{ t('settings.broker.addAuthority') }}
                </button>
              </div>
            </article>
            <div v-if="baseGrants.length === 0" class="broker-editor__empty-grants">
              <strong>{{ t('settings.broker.failClosed') }}</strong>
              <span>{{ t('settings.broker.noBaseAuthority') }}</span>
            </div>
            <button class="broker-editor__add" type="button" @click="addPrincipal()">
              + {{ t('settings.broker.addSenderGrant') }}
            </button>
          </div>
        </section>

        <section class="broker-editor__section" aria-labelledby="broker-conversations-title">
          <div class="broker-editor__section-copy">
            <p>03 // {{ t('settings.broker.overrides') }}</p>
            <h3 id="broker-conversations-title">{{ t('settings.broker.namedConversations') }}</h3>
            <span>{{ t('settings.broker.namedConversationsHelp') }}</span>
          </div>
          <div class="broker-editor__conversation-list">
            <article
              v-for="(conversation, conversationIndex) in conversations"
              :key="conversationIndex"
              class="broker-editor__conversation"
            >
              <header>
                <span
                  >{{ t('settings.broker.conversation') }} //
                  {{ String(conversationIndex + 1).padStart(2, '0') }}</span
                >
                <button type="button" @click="removeConversation(conversationIndex)">
                  {{ t('common.remove') }}
                </button>
              </header>
              <div class="broker-editor__field-grid">
                <NoxTextField
                  :id="`broker-conversation-${String(conversationIndex)}-id`"
                  :model-value="conversation.conversationId"
                  :error="fieldErrors[`conversation.${String(conversationIndex)}.conversationId`]"
                  :hint="t('settings.broker.conversationIdHint')"
                  :label="t('settings.broker.conversationId')"
                  placeholder="channel-id"
                  required
                  @update:model-value="
                    setConversationField(conversationIndex, 'conversationId', $event)
                  "
                />
                <div class="broker-editor__field">
                  <label :for="`broker-conversation-${String(conversationIndex)}-agent`">
                    {{ t('settings.broker.agentOverride') }}
                  </label>
                  <select
                    :id="`broker-conversation-${String(conversationIndex)}-agent`"
                    :value="conversation.agent"
                    @change="
                      setConversationField(
                        conversationIndex,
                        'agent',
                        ($event.target as HTMLSelectElement).value,
                      )
                    "
                  >
                    <option value="">
                      {{
                        t('settings.broker.useBaseAgent', {
                          agent: common.agent || t('settings.broker.baseAgent'),
                        })
                      }}
                    </option>
                    <option v-for="agentId in agents" :key="agentId" :value="agentId">
                      {{ agentId }}
                    </option>
                    <option
                      v-if="conversation.agent && !agents.includes(conversation.agent)"
                      :value="conversation.agent"
                    >
                      {{ conversation.agent }} · {{ t('common.missing') }}
                    </option>
                  </select>
                  <p
                    v-if="fieldErrors[`conversation.${String(conversationIndex)}.agent`]"
                    class="broker-editor__error"
                  >
                    {{ fieldErrors[`conversation.${String(conversationIndex)}.agent`] }}
                  </p>
                </div>
              </div>
              <div v-if="!isWeb" class="broker-editor__nested-grants">
                <article
                  v-for="(principal, principalIndex) in conversation.grants"
                  :key="principalIndex"
                  class="broker-editor__principal"
                >
                  <header>
                    <span
                      >{{ t('settings.broker.sender') }} //
                      {{ String(principalIndex + 1).padStart(2, '0') }}</span
                    >
                    <button
                      type="button"
                      @click="removePrincipal(principalIndex, conversationIndex)"
                    >
                      {{ t('common.remove') }}
                    </button>
                  </header>
                  <NoxTextField
                    :id="`broker-conversation-${String(conversationIndex)}-principal-${String(principalIndex)}`"
                    :model-value="principal.subject"
                    :error="
                      fieldErrors[
                        `conversation.${String(conversationIndex)}.grant.${String(principalIndex)}.subject`
                      ]
                    "
                    :label="t('settings.broker.senderId')"
                    placeholder="sender-id"
                    required
                    @update:model-value="
                      setPrincipalSubject(principalIndex, $event, conversationIndex)
                    "
                  />
                  <div class="broker-editor__patterns">
                    <div v-for="(pattern, patternIndex) in principal.patterns" :key="patternIndex">
                      <NoxTextField
                        :id="`broker-conversation-${String(conversationIndex)}-principal-${String(principalIndex)}-pattern-${String(patternIndex)}`"
                        :model-value="pattern"
                        :error="
                          fieldErrors[
                            `conversation.${String(conversationIndex)}.grant.${String(principalIndex)}.pattern.${String(patternIndex)}`
                          ]
                        "
                        :label="t('settings.broker.authorityPattern')"
                        list="broker-authority-suggestions"
                        placeholder="nox.history.read"
                        required
                        @update:model-value="
                          setPattern(principalIndex, patternIndex, $event, conversationIndex)
                        "
                      />
                      <button
                        type="button"
                        @click="removePattern(principalIndex, patternIndex, conversationIndex)"
                      >
                        ×
                      </button>
                    </div>
                    <button type="button" @click="addPattern(principalIndex, conversationIndex)">
                      + {{ t('settings.broker.addAuthority') }}
                    </button>
                  </div>
                </article>
                <div v-if="conversation.grants.length === 0" class="broker-editor__empty-grants">
                  <strong>{{ t('settings.broker.noConversationGrants') }}</strong>
                  <span>{{ t('settings.broker.noConversationGrantsHelp') }}</span>
                </div>
                <button
                  class="broker-editor__add broker-editor__add--nested"
                  type="button"
                  @click="addPrincipal(conversationIndex)"
                >
                  + {{ t('settings.broker.addConversationSender') }}
                </button>
              </div>
            </article>
            <div v-if="conversations.length === 0" class="broker-editor__empty-grants">
              <strong>{{ t('settings.broker.baseRouteOnly') }}</strong>
              <span>{{ t('settings.broker.baseRouteOnlyHelp') }}</span>
            </div>
            <button class="broker-editor__add" type="button" @click="addConversation()">
              + {{ t('settings.broker.addConversationOverride') }}
            </button>
          </div>
        </section>

        <section class="broker-editor__section" aria-labelledby="broker-payload-title">
          <div class="broker-editor__section-copy">
            <p>04 // {{ t('settings.broker.contribution') }}</p>
            <h3 id="broker-payload-title">{{ t('settings.broker.transportPayload') }}</h3>
            <span>{{ t('settings.broker.transportPayloadHelp') }}</span>
          </div>
          <div class="broker-editor__json-field">
            <div>
              <label for="broker-transport-json">{{ t('settings.broker.contributionJson') }}</label>
              <button type="button" @click="formatTransportJson()">
                {{ t('settings.broker.formatPayload') }}
              </button>
            </div>
            <textarea
              id="broker-transport-json"
              v-model="transportJsonSource"
              :aria-invalid="transportJsonError !== undefined"
              spellcheck="false"
              @input="clearFeedback()"
            ></textarea>
            <p v-if="transportJsonError" class="broker-editor__error">
              {{ transportJsonError }}
            </p>
          </div>
        </section>
      </template>

      <section v-else class="broker-editor__json" aria-labelledby="broker-json-title">
        <div class="broker-editor__section-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3 id="broker-json-title">{{ t('settings.broker.brokerJson') }}</h3>
          <span>{{ t('settings.broker.brokerJsonHelp') }}</span>
        </div>
        <div class="broker-editor__json-field broker-editor__json-field--full">
          <div>
            <label for="broker-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatJson()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="broker-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="broker-editor__error">{{ jsonError }}</p>
        </div>
      </section>

      <section
        v-if="secretReferences.length > 0"
        class="broker-editor__section broker-editor__secrets"
        aria-labelledby="broker-secrets-title"
      >
        <div class="broker-editor__section-copy">
          <p>{{ t('settings.broker.managedCredentials') }}</p>
          <h3 id="broker-secrets-title">{{ t('settings.broker.managedReferences') }}</h3>
          <span>{{ t('settings.broker.managedReferencesHelp') }}</span>
        </div>
        <div class="broker-editor__secret-list">
          <article v-for="reference in secretReferences" :key="reference.path">
            <header>
              <div>
                <span>{{ reference.path }}</span>
                <strong>{{ reference.secretId }}</strong>
              </div>
              <em :class="{ 'broker-editor__secret-missing': !secretStored(reference.secretId) }">
                {{
                  secretStored(reference.secretId)
                    ? t('settings.secrets.stored')
                    : t('common.missing').toUpperCase()
                }}
              </em>
            </header>
            <NoxTextField
              :id="`broker-secret-${reference.path.replace(/[^A-Za-z0-9_-]/g, '-')}`"
              :model-value="pendingSecretValue(reference)"
              autocomplete="new-password"
              :error="fieldErrors[`secret.${reference.path}`]"
              :hint="t('settings.broker.secretValueHint')"
              :label="t('settings.broker.newValueLabel', { secret: reference.secretId })"
              :placeholder="
                t('settings.broker.newValuePlaceholder', { secret: reference.secretId })
              "
              :required="!secretStored(reference.secretId) && common.enabled"
              type="password"
              @update:model-value="setPendingSecret(reference, $event)"
            />
          </article>
        </div>
      </section>

      <datalist id="broker-authority-suggestions">
        <option
          v-for="authority in AUTHORITY_SUGGESTIONS"
          :key="authority"
          :value="authority"
        ></option>
      </datalist>

      <NoxNotice
        v-if="confirmingDelete && !isWeb"
        :title="t('settings.broker.removeQuestion')"
        tone="danger"
      >
        <div class="broker-editor__delete-confirmation">
          <p>{{ t('settings.broker.removeWarning') }}</p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">{{
              t('common.cancel')
            }}</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              {{ t('settings.broker.remove') }}
            </NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="broker-editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating && !isWeb"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        {{ t('settings.broker.remove') }}
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="broker-editor__dirty">{{
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
          {{ t('settings.broker.save') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.broker-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.broker-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.broker-editor__header p,
.broker-editor__header span,
.broker-editor__section-copy p,
.broker-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.broker-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.broker-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.broker-editor__badges,
.broker-editor__modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.broker-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.broker-editor__badges .broker-editor__badge--live {
  color: var(--nox-status-success);
}

.broker-editor__badges .broker-editor__badge--held {
  color: var(--nox-status-warning);
}

.broker-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.broker-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.broker-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.broker-editor__content {
  display: grid;
  width: min(100%, 72rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.broker-editor__section,
.broker-editor__json {
  display: grid;
  grid-template-columns: minmax(13rem, 0.34fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-top: 1px solid var(--nox-border-subtle);
}

.broker-editor__section:last-of-type,
.broker-editor__json {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.broker-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.broker-editor__section-copy > span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.broker-editor__section-copy code {
  color: var(--nox-code-inline);
}

.broker-editor__fields,
.broker-editor__grant-surface,
.broker-editor__conversation-list,
.broker-editor__nested-grants,
.broker-editor__secret-list {
  display: grid;
  align-content: start;
  gap: var(--nox-space-4);
}

.broker-editor__field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-4);
}

.broker-editor__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.broker-editor__field > label,
.broker-editor__json-field label {
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

.broker-editor__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.broker-editor__field select {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.broker-editor__field select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.broker-editor__field--invalid select {
  border-color: var(--nox-status-danger);
}

.broker-editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.broker-editor__enable {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-4);
  min-height: 5rem;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
  cursor: pointer;
}

.broker-editor__enable:has(input:checked) {
  border-color: color-mix(in srgb, var(--nox-action-primary) 45%, var(--nox-border-subtle));
}

.broker-editor__enable input {
  accent-color: var(--nox-action-primary);
}

.broker-editor__enable > span {
  display: grid;
  gap: var(--nox-space-1);
}

.broker-editor__enable strong,
.broker-editor__enable small,
.broker-editor__enable em {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.broker-editor__enable small {
  color: var(--nox-text-muted);
  font-weight: 400;
}

.broker-editor__enable em {
  color: var(--nox-action-primary);
  font-size: 0.6rem;
  font-style: normal;
}

.broker-editor__principal,
.broker-editor__conversation,
.broker-editor__secret-list > article {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.broker-editor__principal > header,
.broker-editor__conversation > header,
.broker-editor__secret-list article > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding-bottom: var(--nox-space-3);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.broker-editor__principal header span,
.broker-editor__conversation header span,
.broker-editor__principal header button,
.broker-editor__conversation header button {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.broker-editor__principal header button,
.broker-editor__conversation header button {
  padding: var(--nox-space-1) var(--nox-space-2);
  background: transparent;
  cursor: pointer;
}

.broker-editor__principal header button:hover,
.broker-editor__conversation header button:hover {
  color: var(--nox-status-danger);
}

.broker-editor__patterns {
  display: grid;
  gap: var(--nox-space-2);
}

.broker-editor__patterns > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--nox-space-2);
}

.broker-editor__patterns button,
.broker-editor__add {
  min-height: 2.25rem;
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-secondary);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.broker-editor__patterns > div > button {
  width: 2.25rem;
  border-style: solid;
  font-size: var(--nox-text-md);
}

.broker-editor__patterns button:hover,
.broker-editor__add:hover {
  border-color: var(--nox-action-primary);
  color: var(--nox-action-primary);
  background: var(--nox-surface-hover);
}

.broker-editor__conversation {
  background: color-mix(in srgb, var(--nox-surface-1) 82%, transparent);
}

.broker-editor__nested-grants {
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-subtle);
}

.broker-editor__add {
  min-height: var(--nox-control-height);
}

.broker-editor__add--nested {
  min-height: 2.5rem;
}

.broker-editor__empty-grants {
  display: grid;
  gap: var(--nox-space-1);
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-subtle);
  color: var(--nox-text-muted);
  background: color-mix(in srgb, var(--nox-surface-1) 55%, transparent);
  text-align: center;
}

.broker-editor__empty-grants strong,
.broker-editor__empty-grants span {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.broker-editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.broker-editor__json-field > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.broker-editor__json-field button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.broker-editor__json-field textarea {
  width: 100%;
  min-height: 18rem;
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

.broker-editor__json-field--full textarea {
  min-height: 42rem;
}

.broker-editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.broker-editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.broker-editor__secret-list article > header > div {
  display: grid;
  gap: var(--nox-space-1);
}

.broker-editor__secret-list article > header span,
.broker-editor__secret-list article > header strong,
.broker-editor__secret-list article > header em {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.broker-editor__secret-list article > header span {
  color: var(--nox-text-muted);
}

.broker-editor__secret-list article > header strong {
  color: var(--nox-text-primary);
}

.broker-editor__secret-list article > header em {
  color: var(--nox-status-success);
  font-style: normal;
}

.broker-editor__secret-list article > header .broker-editor__secret-missing {
  color: var(--nox-status-danger);
}

.broker-editor__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.broker-editor__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.broker-editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.broker-editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.broker-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 60rem) {
  .broker-editor__header,
  .broker-editor__content,
  .broker-editor__actions {
    padding-inline: var(--nox-space-5);
  }

  .broker-editor__section,
  .broker-editor__json {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 40rem) {
  .broker-editor__header,
  .broker-editor__actions,
  .broker-editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .broker-editor__header-side {
    justify-items: start;
  }

  .broker-editor__badges,
  .broker-editor__modes {
    justify-content: flex-start;
  }

  .broker-editor__field-grid {
    grid-template-columns: 1fr;
  }

  .broker-editor__enable {
    grid-template-columns: auto 1fr;
  }

  .broker-editor__enable em {
    grid-column: 2;
  }
}
</style>
