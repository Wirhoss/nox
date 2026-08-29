import { fireEvent, render, screen } from '@testing-library/vue'
import { http, HttpResponse } from 'msw'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import App from '@/app/App.vue'
import router from '@/app/router'
import { server } from '@/tests/server'

const session = {
  agentId: 'operator',
  createdAt: '2026-08-27T13:00:00.000Z',
  sessionId: 'session-1',
  title: 'Inspect the machine',
  updatedAt: '2026-08-27T14:00:07.000Z',
}
const auditAction = {
  authority: 'nox.toolset.web.browser.act',
  createdAt: '2026-08-27T14:00:01.000Z',
  decisions: [
    {
      authority: 'nox.toolset.web.browser.act',
      createdAt: '2026-08-27T14:00:00.000Z',
      decidedBy: 'owner-grants',
      decisionId: 'authorization-1',
      matchedGrant: 'nox.toolset.web.*',
      params: { selector: '#submit' },
      principal: { issuer: 'web', subject: 'operator-1' },
      reason: 'The installation owner holds this authority.',
      runId: 'run-1',
      sessionId: 'session-1',
      stage: 'authorization',
      toolName: 'browser_click',
      toolSetId: 'internet',
      trackId: 'track-1',
      verdict: 'allow',
    },
    {
      authority: 'nox.toolset.web.browser.act',
      createdAt: '2026-08-27T14:00:01.000Z',
      decidedBy: 'risk-gate',
      decisionId: 'gate-1',
      params: { selector: '#submit' },
      preview: 'Submit the remote form',
      principal: { issuer: 'web', subject: 'operator-1' },
      reason: 'The call performs an irreversible network write.',
      resolution: 'approved',
      resolvedAt: '2026-08-27T14:00:05.000Z',
      resolvedBy: { issuer: 'web', subject: 'operator-1' },
      risk: {
        effects: ['network', 'write'],
        resources: [{ kind: 'url', value: 'https://example.test/form' }],
        reversible: false,
      },
      runId: 'run-1',
      scope: 'once',
      sessionId: 'session-1',
      signals: [
        {
          code: 'network-write',
          reason: 'Submitting the form changes remote state.',
          resource: 'https://example.test/form',
          severity: 'approval',
        },
      ],
      stage: 'gate',
      title: 'Submit form',
      toolName: 'browser_click',
      toolSetId: 'internet',
      trackId: 'track-1',
      verdict: 'escalate',
    },
  ],
  responses: [
    {
      content: [{ text: 'Awaiting approval.', type: 'text' }],
      createdAt: '2026-08-27T14:00:02.000Z',
      execution: 'permissionPending',
      isError: false,
      trust: 'trusted',
    },
    {
      content: [
        { text: 'Form submitted.', type: 'text' },
        {
          artifact: {
            artifactId: 'artifact-1',
            filename: 'receipt.json',
            mediaType: 'application/json',
            size: 42,
          },
          type: 'artifact',
        },
      ],
      createdAt: '2026-08-27T14:00:07.000Z',
      execution: 'immediate',
      isError: false,
      trust: 'untrusted',
    },
  ],
  runId: 'run-1',
  sessionId: 'session-1',
  title: 'Submit form',
  toolName: 'browser_click',
  toolSetId: 'internet',
  trackId: 'track-1',
} as const

describe('Sessions route', () => {
  it('opens a session, then keeps its conversation and grouped audit as two views', async () => {
    server.use(...authenticatedOperator(), ...sessionHandlers())

    await renderAt('/sessions')

    expect(await screen.findByRole('heading', { name: 'Sessions', level: 1 })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Sessions/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('link', { name: /Audit/ })).toBeNull()
    expect(screen.queryByRole('search')).toBeNull()
    expect(await screen.findByText('Quiet conversation')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /Inspect the machine/ }))

    expect(await screen.findByRole('heading', { name: 'Inspect the machine' })).toBeTruthy()
    expect(screen.getByText('Submit it.')).toBeTruthy()
    expect(screen.getByText('An operator joined the room.')).toBeTruthy()
    expect(screen.getByText('Form submitted.')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /^Audit/ }))
    expect(await screen.findByText('Submit form')).toBeTruthy()
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0)

    await fireEvent.click(screen.getByText('Submit form'))
    expect(await screen.findByText('Authorization')).toBeTruthy()
    expect(screen.getByText('Risk gate')).toBeTruthy()
    expect(screen.getByText('The installation owner holds this authority.')).toBeTruthy()
    expect(screen.getByText('The call performs an irreversible network write.')).toBeTruthy()
    expect(screen.getByText('network-write')).toBeTruthy()
    expect(screen.getByText('Permission request')).toBeTruthy()
    expect(screen.getByText('Awaiting approval.')).toBeTruthy()
    expect(screen.getByText('Immediate result')).toBeTruthy()
    expect(screen.getByText('Form submitted.')).toBeTruthy()
    expect(screen.getByText('receipt.json')).toBeTruthy()
    expect(screen.getByText('artifact-1')).toBeTruthy()
    expect(screen.getByText('application/json')).toBeTruthy()
    expect(screen.getByText('Permission requested; execution not observed')).toBeTruthy()
    expect(screen.getByText('Tool completed')).toBeTruthy()
  })

  it('keeps a session visible even when it has no audited actions', async () => {
    server.use(...authenticatedOperator(), ...sessionHandlers())

    await renderAt('/sessions')
    await fireEvent.click(await screen.findByRole('button', { name: /Quiet conversation/ }))
    await screen.findByRole('heading', { name: 'Quiet conversation' })
    await fireEvent.click(screen.getByRole('button', { name: /^Audit/ }))

    expect(await screen.findByText('No audited actions')).toBeTruthy()
    expect(screen.getByText('This session contains no capability decisions.')).toBeTruthy()
  })
})

function sessionHandlers() {
  return [
    http.get('*/api/sessions/agents', () =>
      HttpResponse.json({
        agents: [
          {
            agentId: 'operator',
            lastSessionAt: '2026-08-27T14:00:07.000Z',
            sessionCount: 2,
          },
        ],
      }),
    ),
    http.get('*/api/sessions', () =>
      HttpResponse.json({
        entries: [
          session,
          {
            ...session,
            sessionId: 'session-2',
            title: 'Quiet conversation',
            updatedAt: '2026-08-26T14:00:00.000Z',
          },
        ],
        limit: 50,
        offset: 0,
        total: 2,
      }),
    ),
    http.get('*/api/sessions/:sessionId', ({ params }) =>
      HttpResponse.json(
        params.sessionId === 'session-1'
          ? session
          : { ...session, sessionId: 'session-2', title: 'Quiet conversation' },
      ),
    ),
    http.get('*/api/sessions/:sessionId/transcript', ({ params }) =>
      HttpResponse.json({
        entries:
          params.sessionId === 'session-1'
            ? [
                {
                  content: [{ text: 'Submit it.', type: 'text' }],
                  createdAt: '2026-08-27T13:59:00.000Z',
                  messageId: 'message-1',
                  origin: {
                    principal: { issuer: 'web', subject: 'operator-1' },
                    transportMessageId: 'transport-1',
                  },
                  role: 'user',
                },
                {
                  content: [{ text: 'An operator joined the room.', type: 'text' }],
                  createdAt: '2026-08-27T13:59:30.000Z',
                  delivery: 'observation',
                  messageId: 'observation-1',
                  origin: {
                    principal: { issuer: 'web', subject: 'operator-2' },
                    transportMessageId: 'transport-2',
                  },
                  role: 'user',
                },
                {
                  createdAt: '2026-08-27T14:00:07.000Z',
                  execution: 'immediate',
                  isError: false,
                  messageId: 'response-1',
                  name: 'browser_click',
                  response: [{ text: 'Form submitted.', type: 'text' }],
                  role: 'toolResponse',
                  trackId: 'track-1',
                  trust: 'untrusted',
                },
              ]
            : [],
        session:
          params.sessionId === 'session-1'
            ? session
            : { ...session, sessionId: 'session-2', title: 'Quiet conversation' },
        total: params.sessionId === 'session-1' ? 3 : 0,
      }),
    ),
    http.get('*/api/sessions/:sessionId/audit', ({ params }) =>
      HttpResponse.json({
        entries: params.sessionId === 'session-1' ? [auditAction] : [],
        limit: 50,
        offset: 0,
        total: params.sessionId === 'session-1' ? 1 : 0,
      }),
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
