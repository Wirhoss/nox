import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useActiveSessionStore } from './activeSession.store'

let session: ReturnType<typeof useActiveSessionStore>

beforeEach(() => {
  setActivePinia(createPinia())
  session = useActiveSessionStore()
})

afterEach(() => {
  session.$dispose()
})

describe('active chat event projection', () => {
  it('accumulates fragments and replaces them with the settled reply', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      text: 'hel',
      turnId: 'turn-1',
      type: 'fragment',
    })
    session.applyEvent({
      conversationId,
      text: 'lo',
      turnId: 'turn-1',
      type: 'fragment',
    })

    expect(session.items).toMatchObject([
      { kind: 'assistant', streaming: true, text: 'hello', turnId: 'turn-1' },
    ])

    session.applyEvent({
      conversationId,
      text: 'Hello, operator.',
      turnId: 'turn-1',
      type: 'message',
    })

    expect(session.items).toMatchObject([
      { kind: 'assistant', streaming: false, text: 'Hello, operator.', turnId: 'turn-1' },
    ])
    expect(session.run).toEqual({ type: 'idle' })
  })

  it('holds a permission until the stream reports its outcome', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      request: {
        authority: 'mail.send',
        expiresAt: '2026-01-01T00:05:00.000Z',
        params: { to: 'maria@example.com' },
        preview: 'See you Friday.',
        reason: 'External communication needs approval.',
        requestId: 'request-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
        risk: { effects: ['network'], reversible: false },
        runId: 'run-1',
        sessionId: 'session-1',
        signals: [
          { code: 'external', reason: 'Leaves the machine.', severity: 'approval' },
        ],
        title: 'Send email',
        toolName: 'send_email',
        toolSetId: 'mail',
      },
      turnId: 'turn-1',
      type: 'permission',
    })

    expect(session.pendingPermissionCount).toBe(1)
    expect(session.run).toEqual({ requestId: 'request-1', type: 'waiting-permission' })

    session.applyEvent({
      conversationId,
      outcome: { resolution: 'approved', scope: 'once' },
      requestId: 'request-1',
      turnId: 'turn-1',
      type: 'permissionResolved',
    })

    expect(session.pendingPermissionCount).toBe(0)
    expect(session.items[0]).toMatchObject({
      kind: 'permission',
      state: { outcome: { resolution: 'approved', scope: 'once' }, type: 'resolved' },
    })
  })

  it('ignores events addressed to another conversation', () => {
    session.applyEvent({
      conversationId: 'someone_else',
      text: 'not ours',
      turnId: 'turn-1',
      type: 'message',
    })

    expect(session.items).toHaveLength(0)
  })
})
