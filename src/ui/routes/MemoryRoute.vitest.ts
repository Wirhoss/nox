import { fireEvent, render, screen } from '@testing-library/vue'
import { http, HttpResponse } from 'msw'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import App from '@/app/App.vue'
import router from '@/app/router'
import { server } from '@/tests/server'

const scope = {
  accessCount: 4,
  agentId: 'nox',
  episodeCount: 2,
  factCount: 2,
  lastActivityAt: '2026-08-27T14:00:00.000Z',
  liveFactCount: 1,
  principal: { issuer: 'web', subject: 'operator-1' },
}

const liveFact = {
  accessCount: 3,
  confidence: 0.9,
  createdAt: '2026-08-27T13:00:00.000Z',
  id: '1',
  kind: 'preference',
  provenance: [
    {
      completedAt: '2026-08-27T13:00:00.000Z',
      episodeId: '10',
      sessionId: 'session-1',
      trigger: 'user',
    },
  ],
  supportCount: 2,
  text: 'Alice prefers jasmine tea.',
  validFrom: '2026-08-27T13:00:00.000Z',
}

const retiredFact = {
  accessCount: 0,
  confidence: 0.8,
  createdAt: '2026-08-20T13:00:00.000Z',
  id: '2',
  invalidatedAt: '2026-08-27T13:00:00.000Z',
  invalidatedBy: '1',
  kind: 'state',
  provenance: [],
  supportCount: 1,
  text: 'Alice lives in Madrid.',
  validFrom: '2026-08-20T13:00:00.000Z',
  validTo: '2026-08-27T13:00:00.000Z',
}

const episode = {
  completedAt: '2026-08-27T13:00:00.000Z',
  episodeId: '10',
  extractedAt: '2026-08-27T13:00:05.000Z',
  factIds: ['1'],
  runId: 'run-1',
  sessionId: 'session-1',
  startedAt: '2026-08-27T12:59:00.000Z',
  status: 'completed',
  transcript: 'User: I always drink jasmine tea.',
  trigger: 'user',
}

describe('Memory route', () => {
  it('shows what was remembered, its witnesses, and the turn it came from', async () => {
    server.use(...authenticatedOperator(), ...memoryHandlers())

    await renderAt('/memory')

    expect(await screen.findByRole('heading', { name: 'Long-term memory', level: 1 })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Memory/ }).getAttribute('aria-current')).toBe('page')

    // A current fact and a retired one are both shown: the retired one is the
    // record of what used to be true, which is the point of keeping it.
    expect(await screen.findByText('Alice prefers jasmine tea.')).toBeTruthy()
    expect(screen.getByText('Alice lives in Madrid.')).toBeTruthy()
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.getByText('Retired')).toBeTruthy()
    expect(screen.getByText('Stated in 1 turns')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Turns' }))
    expect(await screen.findByText('User: I always drink jasmine tea.')).toBeTruthy()
    expect(screen.getByText(/Extracted/)).toBeTruthy()
  })

  it('corrects a fact through the node rather than in the page', async () => {
    const corrections: { kind: string; text: string }[] = []
    server.use(
      ...authenticatedOperator(),
      ...memoryHandlers(),
      http.put('*/api/memories/semantic/facts/1', async ({ request }) => {
        const body = (await request.json()) as { kind: string; text: string }
        corrections.push({ kind: body.kind, text: body.text })
        return HttpResponse.json({ fact: { id: '1' } })
      }),
    )

    await renderAt('/memory')
    await screen.findByText('Alice prefers jasmine tea.')
    await fireEvent.click(screen.getByRole('button', { name: 'Correct' }))

    const field = await screen.findByLabelText('Statement')
    await fireEvent.update(field, 'Alice prefers green tea.')
    await fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))

    // The editor closes only once the node has accepted the correction, so its
    // return is what says the request actually completed.
    expect(await screen.findByRole('button', { name: 'Correct' })).toBeTruthy()
    expect(corrections).toEqual([{ kind: 'preference', text: 'Alice prefers green tea.' }])
  })

  /**
   * The tools once took any string for a kind, so real installations hold facts
   * under categories the node no longer accepts. Editing one is how they get
   * corrected, and it must not be possible to save it back unchanged.
   */
  it('makes a fact stored under a retired kind pick a real one', async () => {
    const legacy = { ...liveFact, id: '3', kind: 'plan', text: 'Alice will run the QA.' }
    server.use(
      ...authenticatedOperator(),
      http.get(
        '*/api/memories',
        signed(() =>
          HttpResponse.json({ memories: [{ editable: true, id: 'semantic', inspectable: true }] }),
        ),
      ),
      http.get('*/api/memories/semantic/scopes', signed(() => HttpResponse.json({ scopes: [scope] }))),
      http.get(
        '*/api/memories/semantic/facts',
        signed(() => HttpResponse.json({ entries: [legacy], limit: 50, offset: 0, total: 1 })),
      ),
    )

    await renderAt('/memory')
    await screen.findByText('Alice will run the QA.')
    await fireEvent.click(screen.getByRole('button', { name: 'Correct' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))

    expect(await screen.findByText('Choose a kind before saving.')).toBeTruthy()
  })

  /**
   * An audit surface that answers every failure with the same sentence cannot
   * be used to find out why it is showing nothing.
   */
  it('names the status and code when the node refuses', async () => {
    server.use(
      ...authenticatedOperator(),
      http.get(
        '*/api/memories',
        signed(() =>
          HttpResponse.json({ memories: [{ editable: true, id: 'semantic', inspectable: true }] }),
        ),
      ),
      http.get('*/api/memories/semantic/scopes', () =>
        HttpResponse.json({ error: 'memory_unavailable' }, { status: 500 }),
      ),
    )

    await renderAt('/memory')

    expect(
      await screen.findByText('Nox refused the memory request (500 memory_unavailable).'),
    ).toBeTruthy()
  })

  it('says so plainly when no memory can be inspected', async () => {
    server.use(
      ...authenticatedOperator(),
      http.get('*/api/memories', signed(() => HttpResponse.json({ memories: [] }))),
    )

    await renderAt('/memory')

    expect(await screen.findByText('Nothing to inspect')).toBeTruthy()
  })
})

/**
 * Every memory route is behind the auth guard, and the shared request layer
 * sends cookies only — so an unsigned call is a 401 that reads as the memory
 * being unavailable. These handlers refuse like the node does rather than
 * answering anything that asks, which is what makes a forgotten header fail
 * the suite instead of only production.
 */
function signed(
  handler: () => Response,
): (input: { request: Request }) => Response {
  return ({ request }) =>
    request.headers.get('authorization') === 'Bearer access-token'
      ? handler()
      : HttpResponse.json({ error: 'unauthorized' }, { status: 401 })
}

function memoryHandlers() {
  return [
    http.get(
      '*/api/memories',
      signed(() =>
        HttpResponse.json({ memories: [{ editable: true, id: 'semantic', inspectable: true }] }),
      ),
    ),
    http.get('*/api/memories/semantic/scopes', signed(() => HttpResponse.json({ scopes: [scope] }))),
    http.get(
      '*/api/memories/semantic/facts',
      signed(() =>
        HttpResponse.json({ entries: [liveFact, retiredFact], limit: 50, offset: 0, total: 2 }),
      ),
    ),
    http.get(
      '*/api/memories/semantic/episodes',
      signed(() => HttpResponse.json({ entries: [episode], limit: 50, offset: 0, total: 1 })),
    ),
  ] as const
}

function authenticatedOperator() {
  return [
    http.get('*/api/auth/status', () => HttpResponse.json({ registered: true })),
    http.post('*/api/auth/refresh', () =>
      HttpResponse.json({ accessToken: 'access-token', expiresInSeconds: 900 }),
    ),
    http.get('*/api/auth/me', () =>
      HttpResponse.json({
        account: { accountId: 'operator-1', createdAt: 1, username: 'operator' },
      }),
    ),
  ] as const
}

async function renderAt(path: string): Promise<void> {
  await router.push(path)
  await router.isReady()
  render(App, { global: { plugins: [createPinia(), router] } })
}
