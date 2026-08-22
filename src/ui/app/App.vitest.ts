import { render, screen } from '@testing-library/vue'
import { http, HttpResponse } from 'msw'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { server } from '@/tests/server'

import App from './App.vue'
import router from './router'

describe('App auth entry', () => {
  it('opens first-time registration when the Nox node is unclaimed', async () => {
    server.use(
      http.get('*/api/auth/status', () => {
        return HttpResponse.json({ registered: false })
      }),
    )

    await renderAtAccess()

    expect(await screen.findByRole('heading', { name: 'Claim this machine' })).toBeTruthy()
    expect(screen.getByLabelText(/^Claim code/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Claim this Nox' })).toBeTruthy()
  })

  it('opens login when the node is claimed but no browser session survives', async () => {
    server.use(
      http.get('*/api/auth/status', () => HttpResponse.json({ registered: true })),
      http.post('*/api/auth/refresh', () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    )

    await renderAtAccess()

    expect(await screen.findByRole('heading', { name: 'Return to Nox' })).toBeTruthy()
    expect(screen.getByLabelText(/^Identity/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enter Nox' })).toBeTruthy()
  })
})

async function renderAtAccess(): Promise<void> {
  await router.push('/access')
  await router.isReady()
  render(App, {
    global: { plugins: [createPinia(), router] },
  })
}
