<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { useSettingsStore } from '../stores/settings.store'

import type { ConfigSection, ConfigValue } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'
type NumericInputKey = 'accessTtlSeconds' | 'busyTimeoutMs' | 'port' | 'refreshTtlSeconds'

interface ApiDraft extends ConfigValue {
  host: string
  port: number
}

interface AuthDraft extends ConfigValue {
  accessTtlSeconds: number
  refreshTtlSeconds: number
  secureCookies: boolean
}

interface ChatDraft extends ConfigValue {
  defaultAgent?: string
}

interface DatabaseDraft extends ConfigValue {
  busyTimeoutMs: number
  path: string
  synchronous: string
}

interface UiDraft extends ConfigValue {
  locale: string
}

interface AppDraft extends ConfigValue {
  api: ApiDraft
  auth: AuthDraft
  chat: ChatDraft
  database: DatabaseDraft
  logLevel: string
  timezone: string
  ui: UiDraft
}

interface Props {
  blueprintSection?: ConfigSection
  definition: SettingsSectionDefinition
  section: ConfigSection
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const
const SYNCHRONOUS_MODES = ['extra', 'full', 'normal', 'off'] as const
const props = defineProps<Props>()
const settings = useSettingsStore()
const { availableLanguages, plural, setLocale, t } = useI18n()
const mode = ref<EditorMode>('form')
const draft = ref<AppDraft>(appTemplate())
const jsonSource = ref('')
const originalJsonSignature = ref('')
const originalSignature = ref('')
const jsonError = ref<string>()
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const numericInputs = reactive<Record<NumericInputKey, string>>({
  accessTtlSeconds: '900',
  busyTimeoutMs: '5000',
  port: '8080',
  refreshTtlSeconds: '2592000',
})
const selectedValue = computed(() => props.section.value)
const agentIds = computed(() =>
  Object.keys(props.blueprintSection?.value ?? {}).sort((a, b) => a.localeCompare(b)),
)
const configuredDefaultAgent = computed(() => draft.value.chat.defaultAgent ?? '')
const configuredLocaleMissing = computed(
  () => !availableLanguages.value.some((language) => language.locale === draft.value.ui.locale),
)
const defaultAgentMissing = computed(
  () =>
    configuredDefaultAgent.value.length > 0 &&
    !agentIds.value.includes(configuredDefaultAgent.value),
)
const automaticAgentLabel = computed(() => {
  const [only] = agentIds.value
  return agentIds.value.length === 1 && only !== undefined
    ? t('settings.general.automaticAgent', { agent: only })
    : t('settings.general.selectDefaultAgent')
})
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    return parsed === undefined || JSON.stringify(parsed) !== originalJsonSignature.value
  }
  return formSignature() !== originalSignature.value
})

watch(
  selectedValue,
  () => {
    resetEditor()
  },
  { immediate: true },
)

function resetEditor(): void {
  draft.value = asAppDraft(selectedValue.value)
  syncNumericInputs()
  jsonSource.value = JSON.stringify(draft.value, undefined, 2)
  originalJsonSignature.value = JSON.stringify(draft.value)
  fieldErrors.value = {}
  jsonError.value = undefined
  originalSignature.value = formSignature()
}

function syncNumericInputs(): void {
  numericInputs.accessTtlSeconds = String(draft.value.auth.accessTtlSeconds)
  numericInputs.busyTimeoutMs = String(draft.value.database.busyTimeoutMs)
  numericInputs.port = String(draft.value.api.port)
  numericInputs.refreshTtlSeconds = String(draft.value.auth.refreshTtlSeconds)
}

function formSignature(): string {
  return JSON.stringify({ draft: draft.value, numericInputs })
}

function setApiString(field: 'host', value: string): void {
  draft.value = { ...draft.value, api: { ...draft.value.api, [field]: value } }
  clearFeedback(field)
}

function setDatabaseString(field: 'path' | 'synchronous', value: string): void {
  draft.value = { ...draft.value, database: { ...draft.value.database, [field]: value } }
  clearFeedback(field)
}

function setLogLevel(value: string): void {
  draft.value = { ...draft.value, logLevel: value }
  clearFeedback('logLevel')
}

function setUiLocale(value: string): void {
  draft.value = { ...draft.value, ui: { ...draft.value.ui, locale: value } }
  clearFeedback('locale')
  void setLocale(value)
}

function setTimezone(value: string): void {
  draft.value = { ...draft.value, timezone: value }
  clearFeedback('timezone')
}

function setDefaultAgent(value: string): void {
  draft.value = {
    ...draft.value,
    chat:
      value.length === 0
        ? withoutProperty(draft.value.chat, 'defaultAgent')
        : { ...draft.value.chat, defaultAgent: value },
  }
  clearFeedback('defaultAgent')
}

function setSecureCookies(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  draft.value = {
    ...draft.value,
    auth: { ...draft.value.auth, secureCookies: event.target.checked },
  }
  clearFeedback('secureCookies')
}

function setNumericInput(key: NumericInputKey, value: string): void {
  numericInputs[key] = value
  const parsed = Number(value)
  if (Number.isFinite(parsed)) {
    if (key === 'port') {
      draft.value = { ...draft.value, api: { ...draft.value.api, port: parsed } }
    } else if (key === 'busyTimeoutMs') {
      draft.value = {
        ...draft.value,
        database: { ...draft.value.database, busyTimeoutMs: parsed },
      }
    } else {
      draft.value = {
        ...draft.value,
        auth: { ...draft.value.auth, [key]: parsed },
      }
    }
  }
  clearFeedback(key)
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
  draft.value = asAppDraft(parsed)
  syncNumericInputs()
  fieldErrors.value = {}
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

  if (await settings.saveSection(props.section.key, value)) {
    draft.value = asAppDraft(value)
    void setLocale(draft.value.ui.locale)
    syncNumericInputs()
    originalJsonSignature.value = JSON.stringify(value)
    originalSignature.value = formSignature()
  }
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}

  if (draft.value.api.host.trim().length === 0)
    errors.host = t('settings.general.validation.hostRequired')
  validateInteger(errors, 'port', 0, 65_535)
  validateInteger(errors, 'accessTtlSeconds', 60, 60 * 60)
  validateInteger(errors, 'refreshTtlSeconds', 60 * 60, 365 * 24 * 60 * 60)
  validateInteger(errors, 'busyTimeoutMs', 0)

  if (draft.value.database.path.trim().length === 0) {
    errors.path = t('settings.general.validation.pathRequired')
  }
  if (!SYNCHRONOUS_MODES.some((candidate) => candidate === draft.value.database.synchronous)) {
    errors.synchronous = t('settings.general.validation.durabilityMode')
  }
  if (!LOG_LEVELS.some((candidate) => candidate === draft.value.logLevel)) {
    errors.logLevel = t('settings.general.validation.logLevel')
  }
  if (!availableLanguages.value.some((language) => language.locale === draft.value.ui.locale)) {
    errors.locale = t('settings.general.validation.locale')
  }
  if (!knownTimezone(draft.value.timezone)) {
    errors.timezone = t('settings.general.validation.timezone')
  }

  const defaultAgent = configuredDefaultAgent.value
  if (defaultAgent.length === 0 && agentIds.value.length !== 1) {
    errors.defaultAgent = t('settings.general.validation.defaultAgentRequired')
  } else if (defaultAgent.length > 0 && !agentIds.value.includes(defaultAgent)) {
    errors.defaultAgent = t('settings.general.validation.defaultAgentExists')
  }

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateInteger(
  errors: Record<string, string>,
  key: NumericInputKey,
  minimum: number,
  maximum?: number,
): void {
  const value = Number(numericInputs[key])
  if (
    numericInputs[key].trim().length === 0 ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    errors[key] =
      maximum === undefined
        ? t('settings.validation.integerMinimum', { minimum })
        : t('settings.validation.integerRange', { maximum, minimum })
  }
}

function parseJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) jsonError.value = t('settings.general.validation.configurationObject')
      return undefined
    }
    if (report) jsonError.value = undefined
    return parsed
  } catch {
    if (report) {
      jsonError.value = t('settings.validation.invalidJson')
    }
    return undefined
  }
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
  return !dirty.value || window.confirm(t('settings.confirm.discardGeneral'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function asAppDraft(value: ConfigValue): AppDraft {
  const cloned = cloneValue(value)
  const api = objectValue(cloned.api)
  const auth = objectValue(cloned.auth)
  const chat = objectValue(cloned.chat)
  const database = objectValue(cloned.database)
  const ui = objectValue(cloned.ui)
  const defaultAgent = stringValue(chat.defaultAgent)
  const host = stringValue(api.host)
  const path = stringValue(database.path)
  const synchronous = stringValue(database.synchronous)
  const logLevel = stringValue(cloned.logLevel)
  const timezone = stringValue(cloned.timezone)
  const uiLocale = stringValue(ui.locale)

  return {
    ...cloned,
    api: {
      ...api,
      host: host.length > 0 ? host : '0.0.0.0',
      port: numberValue(api.port, 8080),
    },
    auth: {
      ...auth,
      accessTtlSeconds: numberValue(auth.accessTtlSeconds, 900),
      refreshTtlSeconds: numberValue(auth.refreshTtlSeconds, 30 * 24 * 60 * 60),
      secureCookies: booleanValue(auth.secureCookies, false),
    },
    chat: {
      ...withoutProperty(chat, 'defaultAgent'),
      ...(defaultAgent.length > 0 ? { defaultAgent } : {}),
    },
    database: {
      ...database,
      busyTimeoutMs: numberValue(database.busyTimeoutMs, 5000),
      path: path.length > 0 ? path : 'nox.db',
      synchronous: synchronous.length > 0 ? synchronous : 'normal',
    },
    logLevel: logLevel.length > 0 ? logLevel : 'info',
    timezone: timezone.length > 0 ? timezone : 'UTC',
    ui: {
      ...ui,
      locale: uiLocale.length > 0 ? uiLocale : 'en',
    },
  }
}

function appTemplate(): AppDraft {
  return asAppDraft({})
}

/** Whether this browser's own zone database knows the name, which is what the server asks too. */
function knownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function objectValue(value: unknown): ConfigValue {
  return isConfigValue(value) ? value : {}
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

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function cloneValue<T extends ConfigValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withoutProperty(value: ConfigValue, property: string): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}
</script>

<template>
  <article class="app-editor">
    <header class="app-editor__header">
      <div>
        <p>{{ t('settings.general.machineControl') }}</p>
        <h2>{{ t(props.definition.label) }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="app-editor__header-side">
        <div class="app-editor__badges">
          <span>{{ props.section.name }}</span>
          <span class="app-editor__badge--restart">{{
            t('settings.editor.appliesOnRestart')
          }}</span>
        </div>
        <div class="app-editor__modes" :aria-label="t('settings.editor.mode')">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            {{ t('settings.editor.form') }}
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            {{ t('settings.editor.json') }}
          </button>
        </div>
      </div>
    </header>

    <div class="app-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.general.saved')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>{{ t('settings.general.savedBody') }}</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="t('settings.general.changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <template v-if="mode === 'form'">
        <section class="app-editor__section" aria-labelledby="app-interface-title">
          <div class="app-editor__section-copy">
            <p>01 // {{ t('settings.general.interface') }}</p>
            <h3 id="app-interface-title">{{ t('settings.general.interfaceLanguage') }}</h3>
            <span>{{ t('settings.general.interfaceLanguageHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <div
              class="app-editor__field"
              :class="{ 'app-editor__field--invalid': fieldErrors.locale }"
            >
              <label for="app-ui-locale">
                {{ t('settings.general.locale') }}
                <small>{{ t('common.requiredShort') }}</small>
              </label>
              <select
                id="app-ui-locale"
                :value="draft.ui.locale"
                :aria-invalid="fieldErrors.locale !== undefined"
                @change="setUiLocale(($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="language in availableLanguages"
                  :key="language.locale"
                  :value="language.locale"
                >
                  {{ language.name }}
                </option>
                <option v-if="configuredLocaleMissing" :value="draft.ui.locale">
                  {{ draft.ui.locale }} · {{ t('common.missing') }}
                </option>
              </select>
              <p v-if="fieldErrors.locale" class="app-editor__error">
                {{ fieldErrors.locale }}
              </p>
              <p v-else class="app-editor__hint">
                {{ t('settings.general.localeHint') }}
              </p>
            </div>

            <NoxTextField
              id="app-timezone"
              :model-value="draft.timezone"
              :error="fieldErrors.timezone"
              :hint="t('settings.general.timezoneHint')"
              :label="t('settings.general.timezone')"
              placeholder="UTC"
              required
              @update:model-value="setTimezone($event)"
            />
          </div>
        </section>

        <section class="app-editor__section" aria-labelledby="app-network-title">
          <div class="app-editor__section-copy">
            <p>02 // {{ t('settings.general.controlPlane') }}</p>
            <h3 id="app-network-title">{{ t('settings.general.httpListener') }}</h3>
            <span>{{ t('settings.general.httpListenerHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <div class="app-editor__field-grid">
              <NoxTextField
                id="app-api-host"
                :model-value="draft.api.host"
                :error="fieldErrors.host"
                :hint="t('settings.general.bindHostHint')"
                :label="t('settings.general.bindHost')"
                placeholder="0.0.0.0"
                required
                @update:model-value="setApiString('host', $event)"
              />
              <NoxTextField
                id="app-api-port"
                :model-value="numericInputs.port"
                :error="fieldErrors.port"
                :hint="t('settings.general.httpPortHint')"
                inputmode="numeric"
                :label="t('settings.general.httpPort')"
                placeholder="8080"
                required
                @update:model-value="setNumericInput('port', $event)"
              />
            </div>
          </div>
        </section>

        <section class="app-editor__section" aria-labelledby="app-chat-title">
          <div class="app-editor__section-copy">
            <p>03 // {{ t('settings.general.webChat') }}</p>
            <h3 id="app-chat-title">{{ t('settings.general.conversationEntrypoint') }}</h3>
            <span>{{ t('settings.general.conversationEntrypointHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <div
              class="app-editor__field"
              :class="{ 'app-editor__field--invalid': fieldErrors.defaultAgent }"
            >
              <label for="app-default-agent">
                {{ t('settings.general.defaultAgent') }}
                <small v-if="agentIds.length !== 1">{{ t('common.requiredShort') }}</small>
              </label>
              <select
                id="app-default-agent"
                :value="configuredDefaultAgent"
                :aria-invalid="fieldErrors.defaultAgent !== undefined"
                @change="setDefaultAgent(($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ automaticAgentLabel }}</option>
                <option v-for="agentId in agentIds" :key="agentId" :value="agentId">
                  {{ agentId }}
                </option>
                <option v-if="defaultAgentMissing" :value="configuredDefaultAgent">
                  {{ configuredDefaultAgent }} · {{ t('common.missing') }}
                </option>
              </select>
              <p v-if="fieldErrors.defaultAgent" class="app-editor__error">
                {{ fieldErrors.defaultAgent }}
              </p>
              <p v-else class="app-editor__hint">
                {{ plural('settings.general.configuredAgents', agentIds.length) }}
              </p>
            </div>
          </div>
        </section>

        <section class="app-editor__section" aria-labelledby="app-auth-title">
          <div class="app-editor__section-copy">
            <p>04 // {{ t('settings.general.access') }}</p>
            <h3 id="app-auth-title">{{ t('settings.general.sessionSecurity') }}</h3>
            <span>{{ t('settings.general.sessionSecurityHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <div class="app-editor__field-grid">
              <NoxTextField
                id="app-access-ttl"
                :model-value="numericInputs.accessTtlSeconds"
                :error="fieldErrors.accessTtlSeconds"
                :hint="t('settings.general.accessTtlHint')"
                inputmode="numeric"
                :label="t('settings.general.accessTtl')"
                required
                @update:model-value="setNumericInput('accessTtlSeconds', $event)"
              />
              <NoxTextField
                id="app-refresh-ttl"
                :model-value="numericInputs.refreshTtlSeconds"
                :error="fieldErrors.refreshTtlSeconds"
                :hint="t('settings.general.refreshTtlHint')"
                inputmode="numeric"
                :label="t('settings.general.refreshTtl')"
                required
                @update:model-value="setNumericInput('refreshTtlSeconds', $event)"
              />
            </div>
            <label class="app-editor__switch">
              <input
                type="checkbox"
                :checked="draft.auth.secureCookies"
                @change="setSecureCookies($event)"
              />
              <span>
                <strong>{{ t('settings.general.secureCookies') }}</strong>
                <small>{{ t('settings.general.secureCookiesHelp') }}</small>
              </span>
              <b>{{ draft.auth.secureCookies ? t('common.on') : t('common.off') }}</b>
            </label>
            <NoxNotice
              v-if="draft.auth.secureCookies"
              :title="t('settings.general.httpsRequired')"
              tone="warning"
            >
              <p>
                {{ t('settings.general.httpsRequiredHelp') }}
              </p>
            </NoxNotice>
          </div>
        </section>

        <section class="app-editor__section" aria-labelledby="app-database-title">
          <div class="app-editor__section-copy">
            <p>05 // {{ t('settings.general.dataPlane') }}</p>
            <h3 id="app-database-title">{{ t('settings.general.sqliteStorage') }}</h3>
            <span>{{ t('settings.general.sqliteStorageHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <NoxTextField
              id="app-database-path"
              :model-value="draft.database.path"
              :error="fieldErrors.path"
              :hint="t('settings.general.databasePathHint')"
              :label="t('settings.general.databasePath')"
              placeholder="nox.db"
              required
              @update:model-value="setDatabaseString('path', $event)"
            />
            <div class="app-editor__field-grid">
              <NoxTextField
                id="app-busy-timeout"
                :model-value="numericInputs.busyTimeoutMs"
                :error="fieldErrors.busyTimeoutMs"
                :hint="t('settings.general.busyTimeoutHint')"
                inputmode="numeric"
                :label="t('settings.general.busyTimeout')"
                required
                @update:model-value="setNumericInput('busyTimeoutMs', $event)"
              />
              <div
                class="app-editor__field"
                :class="{ 'app-editor__field--invalid': fieldErrors.synchronous }"
              >
                <label for="app-synchronous"
                  >{{ t('settings.general.durabilityMode') }}
                  <small>{{ t('common.requiredShort') }}</small></label
                >
                <select
                  id="app-synchronous"
                  :value="draft.database.synchronous"
                  :aria-invalid="fieldErrors.synchronous !== undefined"
                  @change="
                    setDatabaseString('synchronous', ($event.target as HTMLSelectElement).value)
                  "
                >
                  <option v-for="value in SYNCHRONOUS_MODES" :key="value" :value="value">
                    {{ t(`settings.general.durability.${value}`) }}
                  </option>
                </select>
                <p v-if="fieldErrors.synchronous" class="app-editor__error">
                  {{ fieldErrors.synchronous }}
                </p>
                <p v-else class="app-editor__hint">
                  {{ t('settings.general.durabilityHint') }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section class="app-editor__section" aria-labelledby="app-logging-title">
          <div class="app-editor__section-copy">
            <p>06 // {{ t('settings.general.diagnostics') }}</p>
            <h3 id="app-logging-title">{{ t('settings.general.runtimeLogging') }}</h3>
            <span>{{ t('settings.general.runtimeLoggingHelp') }}</span>
          </div>
          <div class="app-editor__fields">
            <div
              class="app-editor__field"
              :class="{ 'app-editor__field--invalid': fieldErrors.logLevel }"
            >
              <label for="app-log-level"
                >{{ t('settings.general.logLevel') }}
                <small>{{ t('common.requiredShort') }}</small></label
              >
              <select
                id="app-log-level"
                :value="draft.logLevel"
                :aria-invalid="fieldErrors.logLevel !== undefined"
                @change="setLogLevel(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="level in LOG_LEVELS" :key="level" :value="level">
                  {{ level.toUpperCase() }}
                </option>
              </select>
              <p v-if="fieldErrors.logLevel" class="app-editor__error">
                {{ fieldErrors.logLevel }}
              </p>
            </div>
          </div>
        </section>
      </template>

      <section v-else class="app-editor__json" aria-labelledby="app-json-title">
        <div class="app-editor__section-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3 id="app-json-title">{{ t('settings.general.applicationJson') }}</h3>
          <span>{{ t('settings.general.applicationJsonHelp') }}</span>
        </div>
        <div class="app-editor__json-field">
          <div>
            <label for="app-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatJson()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="app-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="app-editor__error">{{ jsonError }}</p>
        </div>
      </section>
    </div>

    <footer class="app-editor__actions">
      <span></span>
      <div>
        <span v-if="dirty" class="app-editor__dirty">{{
          t('settings.editor.unsavedChanges')
        }}</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">{{
          t('common.discard')
        }}</NoxButton>
        <NoxButton :busy="settings.mutation.type === 'saving'" :disabled="!dirty" @click="save()">
          {{ t('settings.general.save') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.app-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.app-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.app-editor__header p,
.app-editor__header span,
.app-editor__section-copy p,
.app-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.app-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.app-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.app-editor__badges,
.app-editor__modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.app-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.app-editor__badges .app-editor__badge--restart {
  border-color: color-mix(in srgb, var(--nox-status-warning) 45%, var(--nox-border-subtle));
  color: var(--nox-status-warning);
}

.app-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.app-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.app-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.app-editor__content {
  display: grid;
  width: min(100%, 68rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.app-editor__section,
.app-editor__json {
  display: grid;
  grid-template-columns: minmax(13rem, 0.36fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-top: 1px solid var(--nox-border-subtle);
}

.app-editor__section:last-of-type,
.app-editor__json {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.app-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.app-editor__section-copy span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.app-editor__section-copy code {
  color: var(--nox-code-inline);
}

.app-editor__fields {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.app-editor__field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-4);
}

.app-editor__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.app-editor__field > label,
.app-editor__json-field label {
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

.app-editor__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.app-editor__field select {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.app-editor__field select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.app-editor__field--invalid select {
  border-color: var(--nox-status-danger);
}

.app-editor__hint,
.app-editor__error {
  margin: 0;
  font-size: var(--nox-text-xs);
  line-height: 1.5;
}

.app-editor__hint {
  color: var(--nox-text-muted);
}

.app-editor__error {
  color: var(--nox-status-danger);
}

.app-editor__switch {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
  cursor: pointer;
}

.app-editor__switch input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--nox-action-primary);
}

.app-editor__switch span {
  display: grid;
  gap: var(--nox-space-1);
}

.app-editor__switch strong,
.app-editor__switch b {
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.app-editor__switch small {
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}

.app-editor__switch b {
  color: var(--nox-action-primary);
}

.app-editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.app-editor__json-field > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.app-editor__json-field button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.app-editor__json-field button:hover {
  color: var(--nox-action-primary);
}

.app-editor__json-field textarea {
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

.app-editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.app-editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.app-editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.app-editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.app-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 60rem) {
  .app-editor__header,
  .app-editor__content,
  .app-editor__actions {
    padding-inline: var(--nox-space-5);
  }

  .app-editor__section,
  .app-editor__json {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 36rem) {
  .app-editor__header,
  .app-editor__actions,
  .app-editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .app-editor__header-side {
    justify-items: start;
  }

  .app-editor__badges,
  .app-editor__modes {
    justify-content: flex-start;
  }

  .app-editor__field-grid {
    grid-template-columns: 1fr;
  }
}
</style>
