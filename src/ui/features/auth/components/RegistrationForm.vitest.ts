import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { http, HttpResponse } from 'msw'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useAuthStore } from '@/app/stores/auth.store'
import { server } from '@/tests/server'

import RegistrationForm from './RegistrationForm.vue'

let auth: ReturnType<typeof useAuthStore>
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  auth = useAuthStore()
})

afterEach(() => {
  auth.$dispose()
})

describe('RegistrationForm', () => {
  it('validates, normalizes and submits the first operator identity', async () => {
    server.use(
      http.post('*/auth/register', async ({ request }) => {
        expect(await request.json()).toEqual({
          code: 'NOX-ACDE-FGHJ-KLMN',
          password: 'night-machine',
          username: 'operator',
        })
        return HttpResponse.json(
          {
            accessToken: 'access-1',
            account: { accountId: 'account-1', createdAt: 1, username: 'operator' },
            expiresInSeconds: 900,
          },
          { status: 201 },
        )
      }),
    )

    render(RegistrationForm, { global: { plugins: [pinia] } })

    await fireEvent.update(screen.getByLabelText(/^Claim code/), 'nox-acde-fghj-klmn')
    await fireEvent.update(screen.getByLabelText(/^Identity/), 'operator')
    await fireEvent.update(screen.getByLabelText(/^Password/), 'night-machine')
    await fireEvent.update(screen.getByLabelText(/^Confirm password/), 'night-machine')
    await fireEvent.click(screen.getByRole('button', { name: 'Claim this Nox' }))

    await waitFor(() => {
      expect(auth.state.type).toBe('authenticated')
    })
  })
})
