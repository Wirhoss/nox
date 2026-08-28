import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'
import { useI18n } from '@/shared/i18n'

import {
  type SessionAgent,
  type SessionAuditPage,
  type SessionPage,
  sessionsApi,
  type SessionSummary,
  type SessionTranscript,
} from '../api/sessions.api'

type SessionsResourceState =
  | { readonly message: string; readonly type: 'failed' }
  | { readonly type: 'idle' }
  | { readonly type: 'loading' }
  | { readonly type: 'ready' }

const EMPTY_SESSIONS: SessionPage = Object.freeze({ entries: [], limit: 50, offset: 0, total: 0 })
const EMPTY_AUDIT: SessionAuditPage = Object.freeze({
  entries: [],
  limit: 50,
  offset: 0,
  total: 0,
})

const useSessionsStore = defineStore('sessions', () => {
  const auth = useAuthStore()
  const { t } = useI18n()
  const agents = ref<readonly SessionAgent[]>([])
  const sessionPage = ref<SessionPage>(EMPTY_SESSIONS)
  const activeSession = ref<SessionSummary>()
  const transcript = ref<SessionTranscript>()
  const auditPage = ref<SessionAuditPage>(EMPTY_AUDIT)
  const navigation = ref<SessionsResourceState>({ type: 'idle' })
  const detail = ref<SessionsResourceState>({ type: 'idle' })
  let navigationVersion = 0
  let detailVersion = 0

  async function loadAgents(): Promise<void> {
    const version = ++navigationVersion
    navigation.value = { type: 'loading' }
    try {
      const nextAgents = await sessionsApi.listAgents(requireAccessToken())
      if (version !== navigationVersion) return
      agents.value = nextAgents
      navigation.value = { type: 'ready' }
    } catch (error) {
      if (version !== navigationVersion) return
      navigation.value = failed(error)
    }
  }

  async function loadSessions(agentId: null | string): Promise<void> {
    const version = ++navigationVersion
    navigation.value = { type: 'loading' }
    sessionPage.value = EMPTY_SESSIONS
    try {
      const page = await sessionsApi.listSessions(requireAccessToken(), agentId)
      if (version !== navigationVersion) return
      sessionPage.value = page
      navigation.value = { type: 'ready' }
    } catch (error) {
      if (version !== navigationVersion) return
      navigation.value = failed(error)
    }
  }

  async function openSession(sessionId: string): Promise<void> {
    const version = ++detailVersion
    detail.value = { type: 'loading' }
    activeSession.value = undefined
    transcript.value = undefined
    auditPage.value = EMPTY_AUDIT
    try {
      const accessToken = requireAccessToken()
      const [session, nextTranscript, nextAudit] = await Promise.all([
        sessionsApi.readSession(accessToken, sessionId),
        sessionsApi.readTranscript(accessToken, sessionId),
        sessionsApi.readAudit(accessToken, sessionId),
      ])
      if (version !== detailVersion) return
      activeSession.value = session
      transcript.value = nextTranscript
      auditPage.value = nextAudit
      detail.value = { type: 'ready' }
    } catch (error) {
      if (version !== detailVersion) return
      detail.value = failed(error)
    }
  }

  async function loadAuditPage(sessionId: string, offset: number): Promise<void> {
    const version = ++detailVersion
    detail.value = { type: 'loading' }
    try {
      const page = await sessionsApi.readAudit(requireAccessToken(), sessionId, offset)
      if (version !== detailVersion) return
      auditPage.value = page
      detail.value = { type: 'ready' }
    } catch (error) {
      if (version !== detailVersion) return
      detail.value = failed(error)
    }
  }

  function requireAccessToken(): string {
    const token = auth.accessToken
    if (token !== undefined) return token
    auth.requireLogin()
    throw new ApiError(401)
  }

  function failed(error: unknown): SessionsResourceState {
    if (error instanceof ApiError && error.status === 401) auth.requireLogin()
    return { message: sessionsErrorMessage(error, t), type: 'failed' }
  }

  return {
    activeSession,
    agents,
    auditPage,
    detail,
    loadAgents,
    loadAuditPage,
    loadSessions,
    navigation,
    openSession,
    sessionPage,
    transcript,
  }
})

function sessionsErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiConnectionError) return t('sessions.error.connection')
  if (error instanceof ApiContractError) return t('sessions.error.contract')
  if (error instanceof ApiError && error.status === 404) return t('sessions.error.notFound')
  if (error instanceof ApiError) return t('sessions.error.request')
  return t('sessions.error.unexpected')
}

export { useSessionsStore }

export type { SessionsResourceState }
