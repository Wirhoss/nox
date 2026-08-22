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
  it('accumulates fragments, settles each reply and waits for run completion', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      modelId: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'user',
      turnId: 'turn-1',
      type: 'runStarted',
    })
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

    expect(session.items.find((item) => item.kind === 'assistant')).toMatchObject({
      kind: 'assistant',
      streaming: true,
      text: 'hello',
      turnId: 'turn-1',
    })

    session.applyEvent({
      conversationId,
      text: 'Hello, operator.',
      turnId: 'turn-1',
      type: 'message',
    })

    expect(session.items.find((item) => item.kind === 'assistant')).toMatchObject({
      kind: 'assistant',
      streaming: false,
      text: 'Hello, operator.',
      turnId: 'turn-1',
    })
    expect(session.run).toEqual({ turnId: 'turn-1', type: 'running' })

    session.applyEvent({
      conversationId,
      durationMs: 1250,
      status: 'completed',
      turnId: 'turn-1',
      type: 'runCompleted',
      usage: { inputTokens: 20, outputTokens: 5 },
    })

    expect(session.run).toEqual({ type: 'idle' })
    expect(session.items.find((item) => item.kind === 'activity')).toMatchObject({
      durationMs: 1250,
      status: 'completed',
      usageTotal: { inputTokens: 20, outputTokens: 5 },
    })
  })

  it('accumulates reasoning fragments and replaces the draft with settled reasoning', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      text: 'I should ',
      turnId: 'turn-reasoning',
      type: 'reasoningFragment',
    })
    session.applyEvent({
      conversationId,
      text: 'inspect first.',
      turnId: 'turn-reasoning',
      type: 'reasoningFragment',
    })

    const activity = session.items.find((item) => item.kind === 'activity')
    expect(activity).toMatchObject({
      reasoning: [{ streaming: true, text: 'I should inspect first.' }],
    })

    session.applyEvent({
      conversationId,
      text: 'Inspect the current state first.',
      turnId: 'turn-reasoning',
      type: 'reasoning',
    })

    expect(activity).toMatchObject({
      reasoning: [{ streaming: false, text: 'Inspect the current state first.' }],
    })

    session.applyEvent({
      conversationId,
      text: 'Now continue.',
      turnId: 'turn-reasoning',
      type: 'reasoningFragment',
    })

    expect(activity?.kind === 'activity' ? activity.reasoning : []).toMatchObject([
      { streaming: false, text: 'Inspect the current state first.' },
      { streaming: true, text: 'Now continue.' },
    ])
  })

  it('projects retries, tool activity, context changes and per-call usage', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      text: 'discard me',
      turnId: 'turn-tools',
      type: 'fragment',
    })
    session.applyEvent({
      conversationId,
      text: 'discard this thought',
      turnId: 'turn-tools',
      type: 'reasoningFragment',
    })
    session.applyEvent({
      attempt: 2,
      conversationId,
      delayMs: 500,
      text: 'Provider overloaded',
      turnId: 'turn-tools',
      type: 'retry',
    })
    session.applyEvent({
      arguments: { path: '/tmp/report' },
      conversationId,
      name: 'read_file',
      trackId: 'track-1',
      turnId: 'turn-tools',
      type: 'toolCall',
    })
    session.applyEvent({
      conversationId,
      execution: 'permissionPending',
      isError: false,
      name: 'read_file',
      text: 'Waiting for approval.',
      trackId: 'track-1',
      turnId: 'turn-tools',
      type: 'toolResponse',
    })
    session.applyEvent({
      conversationId,
      execution: 'deferredResult',
      isError: false,
      name: 'read_file',
      text: 'Report contents.',
      trackId: 'track-1',
      turnId: 'turn-tools',
      type: 'toolResponse',
    })
    session.applyEvent({
      change: 'folded',
      conversationId,
      replacedMessageIds: ['message-1', 'message-2'],
      text: 'Earlier work was summarized.',
      turnId: 'turn-tools',
      type: 'contextChange',
    })
    session.applyEvent({
      conversationId,
      turnId: 'turn-tools',
      type: 'usage',
      usage: { cacheReadTokens: 4, inputTokens: 100, outputTokens: 20 },
    })

    expect(session.items.some((item) => item.kind === 'assistant')).toBe(false)
    expect(session.items.find((item) => item.kind === 'activity')).toMatchObject({
      contextChanges: [{ change: 'folded', replacedMessageIds: ['message-1', 'message-2'] }],
      reasoning: [{ streaming: true, text: '' }],
      retries: [{ attempt: 2, delayMs: 500, text: 'Provider overloaded' }],
      tools: [
        {
          arguments: { path: '/tmp/report' },
          name: 'read_file',
          responses: [
            { execution: 'permissionPending', isError: false, text: 'Waiting for approval.' },
            { execution: 'deferredResult', isError: false, text: 'Report contents.' },
          ],
          trackId: 'track-1',
        },
      ],
      usageCalls: [{ cacheReadTokens: 4, inputTokens: 100, outputTokens: 20 }],
    })
  })

  it('keeps multiple settled assistant messages produced by one run', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      text: 'First step.',
      turnId: 'turn-many',
      type: 'message',
    })
    session.applyEvent({
      conversationId,
      text: 'Second ',
      turnId: 'turn-many',
      type: 'fragment',
    })
    session.applyEvent({
      conversationId,
      text: 'Second step.',
      turnId: 'turn-many',
      type: 'message',
    })

    expect(session.items.filter((item) => item.kind === 'assistant')).toMatchObject([
      { streaming: false, text: 'First step.' },
      { streaming: false, text: 'Second step.' },
    ])
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
    expect(session.run).toEqual({
      requestId: 'request-1',
      turnId: 'turn-1',
      type: 'waiting-permission',
    })

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

  it('marks max-iteration runs as complete but keeps their truncation status', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      modelId: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'deferredResult',
      turnId: 'turn-limited',
      type: 'runStarted',
    })
    session.applyEvent({
      conversationId,
      durationMs: 900,
      status: 'maxIterations',
      turnId: 'turn-limited',
      type: 'runCompleted',
      usage: { inputTokens: 50, outputTokens: 25 },
    })

    expect(session.run).toEqual({ type: 'idle' })
    expect(session.items[0]).toMatchObject({ kind: 'activity', status: 'maxIterations' })
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
