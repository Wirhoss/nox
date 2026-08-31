import { defineStore } from 'pinia'
import { computed, onScopeDispose, readonly, ref } from 'vue'

import { authApi } from '@/features/auth/api/auth.api'
import { ApiConnectionError, ApiContractError, ApiError } from '@/shared/api/http'

import type { Account, Credentials, Registration, Session } from '@/features/auth/api/auth.api'

type AuthActionErrorCode =
  | 'already-registered'
  | 'invalid-code'
  | 'invalid-credentials'
  | 'unavailable'
  | 'unexpected'

type AuthState =
  | { readonly account: Account; readonly type: 'authenticated' }
  | { readonly notice?: 'registration-closed'; readonly type: 'signed-out' }
  | { readonly type: 'checking' }
  | { readonly type: 'registration-required' }
  | { readonly type: 'unavailable' }

class AuthActionError extends Error {
  public readonly cause: unknown
  public readonly code: AuthActionErrorCode

  constructor(code: AuthActionErrorCode, cause?: unknown) {
    super(code)
    this.name = 'AuthActionError'
    this.cause = cause
    this.code = code
  }
}

const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string>()
  const state = ref<AuthState>({ type: 'checking' })
  const isAuthenticated = computed(() => state.value.type === 'authenticated')

  let initialization: Promise<void> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  function initialize(): Promise<void> {
    initialization ??= runInitialization().finally(() => {
      initialization = undefined
    })
    return initialization
  }

  async function runInitialization(): Promise<void> {
    clearSession()
    state.value = { type: 'checking' }

    try {
      const status = await authApi.status()
      if (!status.registered) {
        state.value = { type: 'registration-required' }
        return
      }

      try {
        const token = await authApi.refresh()
        const account = await authApi.me(token.accessToken)
        acceptSession({ ...token, account })
      } catch (error) {
        if (isUnauthorized(error)) {
          state.value = { type: 'signed-out' }
          return
        }
        throw error
      }
    } catch {
      state.value = { type: 'unavailable' }
    }
  }

  async function register(registration: Registration): Promise<void> {
    try {
      acceptSession(await authApi.register(registration))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'already_registered') {
        state.value = { notice: 'registration-closed', type: 'signed-out' }
        throw new AuthActionError('already-registered', error)
      }
      if (error instanceof ApiError && error.code === 'invalid_code') {
        throw new AuthActionError('invalid-code', error)
      }
      throw actionError(error)
    }
  }

  async function login(credentials: Credentials): Promise<void> {
    try {
      acceptSession(await authApi.login(credentials))
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_credentials') {
        throw new AuthActionError('invalid-credentials', error)
      }
      throw actionError(error)
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout()
      requireLogin()
    } catch (error) {
      throw actionError(error)
    }
  }

  function requireLogin(): void {
    clearSession()
    state.value = { type: 'signed-out' }
  }

  function acceptSession(session: Session): void {
    accessToken.value = session.accessToken
    state.value = { account: session.account, type: 'authenticated' }
    scheduleRefresh(session.expiresInSeconds)
  }

  function clearSession(): void {
    accessToken.value = undefined
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  function scheduleRefresh(expiresInSeconds: number): void {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    const delaySeconds = Math.max(1, expiresInSeconds - 30)
    refreshTimer = setTimeout(() => {
      void renewAccessToken()
    }, delaySeconds * 1000)
  }

  async function renewAccessToken(): Promise<void> {
    if (state.value.type !== 'authenticated') return

    try {
      const token = await authApi.refresh()
      accessToken.value = token.accessToken
      scheduleRefresh(token.expiresInSeconds)
    } catch (error) {
      if (isUnauthorized(error)) {
        clearSession()
        state.value = { type: 'signed-out' }
        return
      }

      refreshTimer = setTimeout(() => {
        void renewAccessToken()
      }, 10_000)
    }
  }

  onScopeDispose(clearSession)

  return {
    accessToken: readonly(accessToken),
    initialize,
    isAuthenticated,
    login,
    logout,
    register,
    requireLogin,
    state: readonly(state),
  }
})

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

function actionError(error: unknown): AuthActionError {
  if (error instanceof ApiConnectionError) {
    return new AuthActionError('unavailable', error)
  }
  if (error instanceof ApiContractError) {
    return new AuthActionError('unexpected', error)
  }
  return new AuthActionError('unexpected', error)
}

export { AuthActionError, useAuthStore }

export type { AuthActionErrorCode, AuthState }
