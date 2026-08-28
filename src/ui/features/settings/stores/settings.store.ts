import { defineStore } from 'pinia'
import { readonly, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'
import { useI18n } from '@/shared/i18n'

import {
  type ConfigCatalog,
  type ConfigSection,
  type ConfigValue,
  type ContributionType,
  type Secret,
  settingsApi,
  type ToolSetInventory,
} from '../api/settings.api'

type SettingsResourceState =
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'idle' }
  | { readonly type: 'loading' }
  | { readonly type: 'ready' }

type SettingsMutationState =
  | { readonly message: string; readonly type: 'failed' }
  | { readonly restartRequired: boolean; readonly type: 'saved' }
  | { readonly type: 'idle' }
  | { readonly type: 'saving' }

/** One credential the operator typed alongside the entry that names it. */
interface ManagedSecretWrite {
  readonly secretId: string
  readonly value: string
}

const useSettingsStore = defineStore('settings', () => {
  const auth = useAuthStore()
  const { t } = useI18n()
  const catalog = ref<ConfigCatalog>()
  const references = ref<Readonly<Record<string, ConfigSection>>>({})
  const section = ref<ConfigSection>()
  const secrets = ref<readonly Secret[]>([])
  const toolSetInventory = ref<readonly ToolSetInventory[]>([])
  /** The kinds the section in view may hold, with each kind's own schema. */
  const contributionTypes = ref<readonly ContributionType[]>([])
  const resource = ref<SettingsResourceState>({ type: 'idle' })
  const mutation = ref<SettingsMutationState>({ type: 'idle' })

  let loadVersion = 0

  /** Loads the runtime-owned section catalog before a route tries to resolve its slug. */
  async function loadCatalog(): Promise<ConfigCatalog | undefined> {
    const version = ++loadVersion
    resource.value = { type: 'loading' }
    mutation.value = { type: 'idle' }
    try {
      const nextCatalog = await settingsApi.listConfig(requireAccessToken())
      if (version !== loadVersion) return undefined
      catalog.value = nextCatalog
      resource.value = { type: 'ready' }
      return nextCatalog
    } catch (error) {
      if (version !== loadVersion) return undefined
      failResource(error)
      return undefined
    }
  }

  async function loadSection(sectionKey: string): Promise<void> {
    const version = ++loadVersion
    resource.value = { type: 'loading' }
    mutation.value = { type: 'idle' }

    try {
      const accessToken = requireAccessToken()
      const [nextCatalog, nextSection] = await Promise.all([
        settingsApi.listConfig(accessToken),
        settingsApi.readSection(accessToken, sectionKey),
      ])
      if (version !== loadVersion) return
      catalog.value = nextCatalog

      const summary = nextCatalog.sections.find((candidate) => candidate.key === sectionKey)
      const referenceKeys = summary?.references ?? []
      const contributionSection = nextSection.kind === 'contribution'
      const [nextReferences, nextSecrets, nextToolSetInventory, nextContributionTypes] =
        await Promise.all([
          Promise.all(
            referenceKeys.map(
              async (key) => [key, await settingsApi.readSection(accessToken, key)] as const,
            ),
          ),
          contributionSection ? settingsApi.listSecrets(accessToken) : undefined,
          summary?.inventory === 'toolSets'
            ? settingsApi.listToolSetInventory(accessToken)
            : [],
          contributionSection ? settingsApi.listSectionTypes(accessToken, sectionKey) : [],
        ])
      if (version !== loadVersion) return
      references.value = Object.fromEntries(nextReferences)
      if (nextSecrets !== undefined) secrets.value = nextSecrets
      toolSetInventory.value = nextToolSetInventory
      contributionTypes.value = nextContributionTypes
      section.value = nextSection
      resource.value = { type: 'ready' }
    } catch (error) {
      if (version !== loadVersion) return
      failResource(error)
    }
  }

  async function loadSecrets(): Promise<void> {
    const version = ++loadVersion
    resource.value = { type: 'loading' }
    mutation.value = { type: 'idle' }

    try {
      const accessToken = requireAccessToken()
      const [nextCatalog, nextSecrets] = await Promise.all([
        settingsApi.listConfig(accessToken),
        settingsApi.listSecrets(accessToken),
      ])
      if (version !== loadVersion) return
      catalog.value = nextCatalog
      section.value = undefined
      secrets.value = nextSecrets
      resource.value = { type: 'ready' }
    } catch (error) {
      if (version !== loadVersion) return
      failResource(error)
    }
  }

  async function reloadConfiguration(): Promise<void> {
    mutation.value = { type: 'saving' }
    try {
      catalog.value = await settingsApi.reloadConfiguration(requireAccessToken())
      mutation.value = { restartRequired: false, type: 'saved' }
    } catch (error) {
      if (isUnauthorized(error)) auth.requireLogin()
      mutation.value = { message: settingsErrorMessage(error, t), type: 'failed' }
    }
  }

  async function retryRuntime(): Promise<void> {
    mutation.value = { type: 'saving' }
    try {
      const recovery = await settingsApi.retryRuntime(requireAccessToken())
      if (catalog.value !== undefined) {
        catalog.value = {
          ...catalog.value,
          revertAvailable: recovery.revertAvailable,
          runtime: recovery.components,
        }
      }
      mutation.value = { restartRequired: false, type: 'saved' }
    } catch (error) {
      if (isUnauthorized(error)) auth.requireLogin()
      mutation.value = { message: settingsErrorMessage(error, t), type: 'failed' }
    }
  }

  async function revertRuntime(): Promise<void> {
    mutation.value = { type: 'saving' }
    try {
      const recovery = await settingsApi.revertRuntime(requireAccessToken())
      if (catalog.value !== undefined) {
        catalog.value = {
          ...catalog.value,
          revertAvailable: recovery.revertAvailable,
          runtime: recovery.components,
        }
      }
      mutation.value = { restartRequired: false, type: 'saved' }
      const sectionKey = section.value?.key
      if (sectionKey !== undefined) await loadSection(sectionKey)
    } catch (error) {
      if (isUnauthorized(error)) auth.requireLogin()
      mutation.value = { message: settingsErrorMessage(error, t), type: 'failed' }
    }
  }

  async function saveSection(sectionKey: string, value: ConfigValue): Promise<boolean> {
    return mutate(async () => {
      const saved = await settingsApi.replaceSection({
        accessToken: requireAccessToken(),
        section: sectionKey,
        value,
      })
      const { restartRequired, revertAvailable, runtime, ...nextSection } = saved
      section.value = nextSection
      updateRuntime(runtime, revertAvailable)
      return restartRequired
    })
  }

  async function createEntry(
    sectionKey: string,
    entryId: string,
    value: ConfigValue,
  ): Promise<boolean> {
    return mutate(async () => {
      const saved = await settingsApi.createEntry({
        accessToken: requireAccessToken(),
        entryId,
        section: sectionKey,
        value,
      })
      updateEntry(entryId, saved.value)
      updateRuntime(saved.runtime, saved.revertAvailable)
      return saved.restartRequired
    })
  }

  async function saveEntry(
    sectionKey: string,
    entryId: string,
    value: ConfigValue,
  ): Promise<boolean> {
    return mutate(async () => {
      const saved = await settingsApi.replaceEntry({
        accessToken: requireAccessToken(),
        entryId,
        section: sectionKey,
        value,
      })
      updateEntry(entryId, saved.value)
      updateRuntime(saved.runtime, saved.revertAvailable)
      return saved.restartRequired
    })
  }

  async function deleteEntry(sectionKey: string, entryId: string): Promise<boolean> {
    return mutate(async () => {
      const removed = await settingsApi.deleteEntry({
        accessToken: requireAccessToken(),
        entryId,
        section: sectionKey,
      })
      updateRuntime(removed.runtime, removed.revertAvailable)
      if (section.value !== undefined) {
        const nextValue = Object.fromEntries(
          Object.entries(section.value.value).filter(([candidateId]) => candidateId !== entryId),
        )
        section.value = { ...section.value, value: nextValue }
      }
      return removed.restartRequired
    })
  }

  async function saveSecret(secretId: string, value: string): Promise<boolean> {
    return mutate(async () => {
      const saved = await settingsApi.saveSecret({
        accessToken: requireAccessToken(),
        secretId,
        value,
      })
      upsertSecret(saved)
      return saved.restartRequired
    })
  }

  /**
   * Writes the credentials an entry names, then the entry itself.
   *
   * One operation because it is one intent: an operator filling in a provider
   * types the endpoint and the key together, and a form that saved the entry
   * first would leave configuration naming a secret that does not exist yet.
   * Secrets go first for the same reason.
   */
  async function saveEntryWithSecrets(
    sectionKey: string,
    entryId: string,
    value: ConfigValue,
    creating: boolean,
    secretWrites: readonly ManagedSecretWrite[] = [],
  ): Promise<boolean> {
    return mutate(async () => {
      const accessToken = requireAccessToken()
      let secretRestartRequired = false
      for (const secretWrite of secretWrites) {
        const savedSecret = await settingsApi.saveSecret({ accessToken, ...secretWrite })
        upsertSecret(savedSecret)
        secretRestartRequired ||= savedSecret.restartRequired
      }

      const savedEntry = creating
        ? await settingsApi.createEntry({ accessToken, entryId, section: sectionKey, value })
        : await settingsApi.replaceEntry({ accessToken, entryId, section: sectionKey, value })
      updateEntry(entryId, savedEntry.value)
      updateRuntime(savedEntry.runtime, savedEntry.revertAvailable)
      return secretRestartRequired || savedEntry.restartRequired
    })
  }

  /**
   * Deleting a secret deletes its value, not its name. An ID configuration still
   * names survives as an unset row — dropping it would hide a credential the
   * configuration still expects, which is the failure this list exists to
   * prevent.
   */
  async function deleteSecret(secretId: string): Promise<boolean> {
    return mutate(async () => {
      const removed = await settingsApi.deleteSecret({
        accessToken: requireAccessToken(),
        secretId,
      })
      secrets.value =
        removed.references.length === 0
          ? secrets.value.filter((secret) => secret.secretId !== secretId)
          : secrets.value.map((secret) =>
              secret.secretId === secretId
                ? {
                    consumers: secret.consumers,
                    references: removed.references,
                    restartRequired: removed.restartRequired,
                    secretId,
                    stored: false,
                  }
                : secret,
            )
      return removed.restartRequired
    })
  }

  function clearMutation(): void {
    mutation.value = { type: 'idle' }
  }

  function upsertSecret(saved: Secret): void {
    secrets.value = [
      ...secrets.value.filter((secret) => secret.secretId !== saved.secretId),
      saved,
    ].sort((a, b) => a.secretId.localeCompare(b.secretId))
  }

  function updateRuntime(
    runtime: ConfigCatalog['runtime'],
    revertAvailable: boolean,
  ): void {
    if (catalog.value !== undefined) {
      catalog.value = { ...catalog.value, revertAvailable, runtime }
    }
  }

  function updateEntry(entryId: string, value: ConfigValue): void {
    if (section.value === undefined) return
    section.value = {
      ...section.value,
      value: { ...section.value.value, [entryId]: value },
    }
  }

  async function mutate(operation: () => Promise<boolean>): Promise<boolean> {
    mutation.value = { type: 'saving' }
    try {
      const restartRequired = await operation()
      mutation.value = { restartRequired, type: 'saved' }
      return true
    } catch (error) {
      if (isUnauthorized(error)) auth.requireLogin()
      mutation.value = { message: settingsErrorMessage(error, t), type: 'failed' }
      return false
    }
  }

  function failResource(error: unknown): void {
    if (isUnauthorized(error)) auth.requireLogin()
    resource.value = { message: settingsErrorMessage(error, t), type: 'failed' }
  }

  function requireAccessToken(): string {
    const token = auth.accessToken
    if (token === undefined) throw new Error('Settings requires an authenticated Nox session.')
    return token
  }

  return {
    catalog: readonly(catalog),
    clearMutation,
    createEntry,
    deleteEntry,
    deleteSecret,
    loadCatalog,
    loadSection,
    loadSecrets,
    mutation: readonly(mutation),
    references: readonly(references),
    resource: readonly(resource),
    reloadConfiguration,
    retryRuntime,
    revertRuntime,
    saveEntry,
    saveEntryWithSecrets,
    saveSecret,
    saveSection,
    section: readonly(section),
    secrets: readonly(secrets),
    toolSetInventory: readonly(toolSetInventory),
    contributionTypes: readonly(contributionTypes),
  }
})

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

type Translate = (
  key: string,
  parameters?: Readonly<Record<string, boolean | number | string>>,
) => string

function settingsErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'entry_exists':
        return t('settings.error.entryExists')
      case 'entry_in_use':
        return t('settings.error.entryInUse')
      case 'invalid_config':
        // The detail is the schema's own complaint — which field, and what it
        // wanted. Reporting only that a change was refused leaves somebody
        // guessing at exactly the moment the answer is already in hand.
        return error.detail ?? t('settings.error.invalidConfig')
      case 'section_unresolved':
        return t('settings.error.sectionUnresolved')
      case 'unknown_reference':
        return t('settings.error.unknownReference')
      case undefined:
        return t('settings.error.refused', { status: error.status })
      default:
        return t('settings.error.refusedWithCode', { code: error.code, status: error.status })
    }
  }
  if (error instanceof ApiConnectionError) return t('settings.error.nodeUnreachable')
  if (error instanceof ApiContractError) return t('settings.error.unexpectedResponse')
  return t('settings.error.unexpected')
}

export { settingsErrorMessage, useSettingsStore }

export type { SettingsMutationState, SettingsResourceState }
