import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'
import { useI18n } from '@/shared/i18n'

import { memoryApi } from '../api/memory.api'

import type { MemoryEpisodePage, MemoryFactPage, MemoryScopeSummary, MemorySummary } from '../api/memory.api'

type MemoryResourceState =
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'idle' }
  | { readonly type: 'loading' }
  | { readonly type: 'ready' }

type MemoryTab = 'episodes' | 'facts'

const PAGE_SIZE = 50
const EMPTY_FACTS: MemoryFactPage = Object.freeze({
  entries: [],
  limit: PAGE_SIZE,
  offset: 0,
  total: 0,
})
const EMPTY_EPISODES: MemoryEpisodePage = Object.freeze({
  entries: [],
  limit: PAGE_SIZE,
  offset: 0,
  total: 0,
})

const useMemoryStore = defineStore('memory', () => {
  const auth = useAuthStore()
  const { t } = useI18n()
  const memories = ref<readonly MemorySummary[]>([])
  const activeMemoryId = ref<string>()
  const scopes = ref<readonly MemoryScopeSummary[]>([])
  const activeScope = ref<MemoryScopeSummary>()
  const facts = ref<MemoryFactPage>(EMPTY_FACTS)
  const episodes = ref<MemoryEpisodePage>(EMPTY_EPISODES)
  const tab = ref<MemoryTab>('facts')
  const navigation = ref<MemoryResourceState>({ type: 'idle' })
  const detail = ref<MemoryResourceState>({ type: 'idle' })
  // Guards against a slower earlier request landing on top of a newer one when
  // the operator clicks through scopes faster than the node answers.
  let navigationVersion = 0
  let detailVersion = 0

  const activeMemory = computed(() =>
    memories.value.find((memory) => memory.id === activeMemoryId.value),
  )
  const editable = computed(() => activeMemory.value?.editable === true)

  /**
   * Why the node refused, in enough detail to act on.
   *
   * The status and the node's own error code are carried through rather than
   * collapsed into one sentence. This is the surface an owner opens when they
   * want to know what Nox is holding; one that answers every failure with the
   * same words cannot be used to find out why it is holding nothing.
   */
  /**
   * The bearer token, or a 401 raised here rather than sent unsigned.
   *
   * The shared request layer sends cookies only, so every authenticated route
   * is signed by its caller. Failing here means the page sends the operator to
   * log in instead of reporting the memory as unavailable, which is what an
   * unsigned request looks like from the other side.
   */
  function requireAccessToken(): string {
    const token = auth.accessToken
    if (token !== undefined) return token
    auth.requireLogin()
    throw new ApiError(401)
  }

  function describe(error: unknown): string {
    if (error instanceof ApiError && error.status === 401) auth.requireLogin()
    if (error instanceof ApiConnectionError) return t('memory.error.connection')
    if (error instanceof ApiContractError) return t('memory.error.contract')
    if (error instanceof ApiError) {
      if (error.status === 404) return t('memory.error.notFound')
      if (error.code === 'memory_not_inspectable') return t('memory.error.notInspectable')
      const reason = [error.code, error.detail].filter((part) => part !== undefined).join(': ')
      return t('memory.error.refused', {
        detail: reason.length === 0 ? String(error.status) : `${String(error.status)} ${reason}`,
      })
    }
    return error instanceof Error && error.message.length > 0
      ? t('memory.error.refused', { detail: error.message })
      : t('memory.error.request')
  }

  async function loadMemories(): Promise<void> {
    const version = ++navigationVersion
    navigation.value = { type: 'loading' }
    try {
      const found = await memoryApi.list(requireAccessToken())
      if (version !== navigationVersion) return
      memories.value = found
      const inspectable = found.find((memory) => memory.inspectable)
      navigation.value = { type: 'ready' }
      if (inspectable !== undefined) await selectMemory(inspectable.id)
    } catch (error) {
      if (version !== navigationVersion) return
      navigation.value = { message: describe(error), type: 'failed' }
    }
  }

  async function selectMemory(memoryId: string): Promise<void> {
    const version = ++navigationVersion
    activeMemoryId.value = memoryId
    activeScope.value = undefined
    facts.value = EMPTY_FACTS
    episodes.value = EMPTY_EPISODES
    navigation.value = { type: 'loading' }
    try {
      const found = await memoryApi.scopes(requireAccessToken(), memoryId)
      if (version !== navigationVersion) return
      scopes.value = found
      navigation.value = { type: 'ready' }
      const first = found[0]
      if (first !== undefined) await selectScope(first)
    } catch (error) {
      if (version !== navigationVersion) return
      navigation.value = { message: describe(error), type: 'failed' }
    }
  }

  async function selectScope(scope: MemoryScopeSummary): Promise<void> {
    activeScope.value = scope
    await loadPage(0)
  }

  async function selectTab(next: MemoryTab): Promise<void> {
    tab.value = next
    await loadPage(0)
  }

  async function loadPage(offset: number): Promise<void> {
    const memoryId = activeMemoryId.value
    const scope = activeScope.value
    if (memoryId === undefined || scope === undefined) return

    const version = ++detailVersion
    detail.value = { type: 'loading' }
    const selector = {
      agentId: scope.agentId,
      issuer: scope.principal.issuer,
      limit: PAGE_SIZE,
      offset,
      subject: scope.principal.subject,
    }
    try {
      if (tab.value === 'facts') {
        const page = await memoryApi.facts(requireAccessToken(), memoryId, selector)
        if (version !== detailVersion) return
        facts.value = page
      } else {
        const page = await memoryApi.episodes(requireAccessToken(), memoryId, selector)
        if (version !== detailVersion) return
        episodes.value = page
      }
      detail.value = { type: 'ready' }
    } catch (error) {
      if (version !== detailVersion) return
      detail.value = { message: describe(error), type: 'failed' }
    }
  }

  /** Reloads rather than patching in place, so counts and ordering stay the node's. */
  async function correct(factId: string, kind: string, text: string): Promise<void> {
    const memoryId = activeMemoryId.value
    const scope = activeScope.value
    if (memoryId === undefined || scope === undefined) return
    await memoryApi.update(requireAccessToken(), memoryId, factId, {
      agentId: scope.agentId,
      issuer: scope.principal.issuer,
      kind,
      subject: scope.principal.subject,
      text,
    })
    await loadPage(facts.value.offset)
  }

  async function retire(factId: string): Promise<void> {
    const memoryId = activeMemoryId.value
    const scope = activeScope.value
    if (memoryId === undefined || scope === undefined) return
    await memoryApi.forget(requireAccessToken(), memoryId, factId, {
      agentId: scope.agentId,
      issuer: scope.principal.issuer,
      subject: scope.principal.subject,
    })
    await loadPage(facts.value.offset)
  }

  return {
    activeMemory,
    activeMemoryId,
    activeScope,
    correct,
    detail,
    editable,
    episodes,
    facts,
    loadMemories,
    loadPage,
    memories,
    navigation,
    PAGE_SIZE,
    retire,
    scopes,
    selectMemory,
    selectScope,
    selectTab,
    tab,
  }
})

export { useMemoryStore }

export type { MemoryTab }
