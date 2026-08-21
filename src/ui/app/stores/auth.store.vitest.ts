import { http, HttpResponse } from 'msw'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/tests/server'

import { useAuthStore } from './auth.store'

const account = {
  accountId: 'account-1',
  createdAt: 1,
  username: 'operator',
} as const

let store: ReturnType<typeof useAuthStore>

beforeEach(() => {
  setActivePinia(createPinia())
  store = useAuthStore()
})

afterEach(() => {
  store.$dispose()
})

describe('auth store bootstrap', () => {
  it('requires registration when the node has no account', async () => {
    server.use(http.get('*/auth/status', () => HttpResponse.json({ registered: false })))

    await store.initialize()

    expect(store.state).toEqual({ type: 'registration-required' })
    expect(store.accessToken).toBeUndefined()
  })

  it('offers login when a registered node has no refresh session', async () => {
    server.use(
      http.get('*/auth/status', () => HttpResponse.json({ registered: true })),
      http.post('*/auth/refresh', () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    )

    await store.initialize()

    expect(store.state).toEqual({ type: 'signed-out' })
  })

  it('restores an existing session through the HttpOnly refresh cookie', async () => {
    server.use(
      http.get('*/auth/status', () => HttpResponse.json({ registered: true })),
      http.post('*/auth/refresh', () =>
        HttpResponse.json({ accessToken: 'restored-access', expiresInSeconds: 900 }),
      ),
      http.get('*/auth/me', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer restored-access')
        return HttpResponse.json({ account })
      }),
    )

    await store.initialize()

    expect(store.accessToken).toBe('restored-access')
    expect(store.state).toEqual({ account, type: 'authenticated' })
  })
})

describe('auth store registration', () => {
  it('keeps the access token in memory and exposes the account after claiming Nox', async () => {
    server.use(
      http.post('*/auth/register', async ({ request }) => {
        expect(await request.json()).toEqual({
          code: 'NOX-ABCD-EFGH-JKLM',
          password: 'night-machine',
          username: 'operator',
        })
        return HttpResponse.json(
          { accessToken: 'access-1', account, expiresInSeconds: 900 },
          { status: 201 },
        )
      }),
    )

    await store.register({
      code: 'NOX-ABCD-EFGH-JKLM',
      password: 'night-machine',
      username: 'operator',
    })

    expect(store.accessToken).toBe('access-1')
    expect(store.state).toEqual({ account, type: 'authenticated' })
  })
})
