import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/app/stores/auth.store'
import { authApi } from '@/features/auth/api/auth.api'
import { ApiError } from '@/shared/api/http'

import { chatApi } from '../api/chat.api'
import { useActiveSessionStore } from './activeSession.store'

let auth: ReturnType<typeof useAuthStore>
let session: ReturnType<typeof useActiveSessionStore>

beforeEach(() => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  session = useActiveSessionStore()
})

afterEach(() => {
  session.$dispose()
  auth.$dispose()
  vi.restoreAllMocks()
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

  it('preserves the position of artifacts inside a settled assistant message', () => {
    const conversationId = session.conversationId
    const content = [
      { text: 'Before.', type: 'text' as const },
      {
        artifact: {
          artifactId: 'artifact-1',
          filename: 'result.png',
          mediaType: 'image/png',
          size: 128,
        },
        type: 'artifact' as const,
      },
      { text: 'After.', type: 'text' as const },
    ]

    session.applyEvent({
      content,
      conversationId,
      text: 'Before.After.',
      turnId: 'turn-artifact',
      type: 'message',
    })

    expect(session.items.find((item) => item.kind === 'assistant')).toMatchObject({
      content,
      media: [content[1]],
      text: 'Before.After.',
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

  it('places reasoning and tools before their reply and leaves the run summary last', () => {
    const conversationId = session.conversationId

    session.applyEvent({
      conversationId,
      modelId: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'user',
      turnId: 'turn-ordered',
      type: 'runStarted',
    })
    session.applyEvent({
      conversationId,
      text: 'I should inspect the file.',
      turnId: 'turn-ordered',
      type: 'reasoning',
    })
    session.applyEvent({
      arguments: { path: '/tmp/report' },
      conversationId,
      name: 'read_file',
      trackId: 'track-ordered',
      turnId: 'turn-ordered',
      type: 'toolCall',
    })
    session.applyEvent({
      conversationId,
      execution: 'immediate',
      isError: false,
      name: 'read_file',
      text: 'Report contents.',
      trackId: 'track-ordered',
      turnId: 'turn-ordered',
      type: 'toolResponse',
    })
    session.applyEvent({
      conversationId,
      text: 'The report is ready.',
      turnId: 'turn-ordered',
      type: 'message',
    })

    expect(session.items.map((item) => item.kind)).toEqual([
      'reasoning',
      'tool',
      'assistant',
      'activity',
    ])
    expect(session.items[2]).toMatchObject({ createdAt: expect.any(String) })
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
        signals: [{ code: 'external', reason: 'Leaves the machine.', severity: 'approval' }],
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

  it('keeps the latest context accounting published by the runtime', () => {
    session.applyEvent({
      conversationId: session.conversationId,
      turnId: 'turn-context',
      type: 'contextUsage',
      usage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
    })

    expect(session.contextUsage).toEqual({
      compactAtTokens: 6_400,
      contextWindow: 10_000,
      usedTokens: 3_200,
    })
    expect(session.items).toHaveLength(0)
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

describe('active chat surface integration', () => {
  beforeEach(async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({
      accessToken: 'access-token',
      account: { accountId: 'account-1', createdAt: 1, username: 'operator' },
      expiresInSeconds: 3_600,
    })
    await auth.login({ password: 'secret', username: 'operator' })

    vi.spyOn(chatApi, 'openStream').mockImplementation(
      ({ opened, signal }) =>
        new Promise<void>((resolve) => {
          opened()
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        }),
    )
  })

  it('retries while the chat transport is temporarily unavailable', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
      vi.spyOn(chatApi, 'listConversations').mockResolvedValue([])
      let attempts = 0
      vi.spyOn(chatApi, 'openStream').mockImplementation(({ opened, signal }) => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(new ApiError(503, { error: 'chat_unavailable' }))
        }
        return new Promise<void>((resolve) => {
          opened('stream-instance')
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        })
      })

      await session.initialize()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(attempts).toBe(2)
      expect(session.connection).toEqual({ type: 'connected' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes a dropped stream from its last event cursor', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
      vi.spyOn(chatApi, 'listConversations').mockResolvedValue([])
      const cursors: (string | undefined)[] = []
      let attempts = 0
      vi.spyOn(chatApi, 'openStream').mockImplementation(
        ({ lastEventId, listener, opened, signal }) => {
          attempts += 1
          cursors.push(lastEventId)
          opened('same-backend')
          if (attempts === 1) {
            listener(
              {
                conversationId: session.conversationId,
                modelId: 'test-model',
                startedAt: '2026-01-01T00:00:00.000Z',
                trigger: 'user',
                turnId: 'turn-resumed',
                type: 'runStarted',
              },
              '1',
            )
            listener(
              {
                conversationId: session.conversationId,
                text: 'before ',
                turnId: 'turn-resumed',
                type: 'fragment',
              },
              '2',
            )
            return Promise.resolve()
          }

          listener(
            {
              conversationId: session.conversationId,
              text: 'after',
              turnId: 'turn-resumed',
              type: 'fragment',
            },
            '3',
          )
          return new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
        },
      )

      await session.initialize()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(cursors).toEqual([undefined, '2'])
      expect(session.run).toEqual({ turnId: 'turn-resumed', type: 'running' })
      expect(session.items.find((item) => item.kind === 'assistant')).toMatchObject({
        streaming: true,
        text: 'before after',
      })
      expect(session.sendError).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the latest conversation and reconstructs its transcript', async () => {
    vi.spyOn(chatApi, 'listCommands').mockResolvedValue([
      { description: 'Stops the run.', name: 'stop', parameters: { type: 'object' } },
    ])
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue([
      {
        agentId: 'assistant',
        contextUsage: { contextWindow: 10_000, usedTokens: 3_200 },
        conversationId: 'web_previous',
        sessionId: 'session-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'closed',
        updatedAt: '2026-01-01T00:00:04.000Z',
      },
    ])
    vi.spyOn(chatApi, 'readHistory').mockResolvedValue({
      agentId: 'assistant',
      contextUsage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_300 },
      conversationId: 'web_previous',
      entries: [
        {
          at: '2026-01-01T00:00:00.000Z',
          messageId: 'message-user',
          principal: { issuer: 'web', subject: 'account-1' },
          text: 'Inspect it.',
          type: 'userMessage',
        },
        {
          at: '2026-01-01T00:00:01.000Z',
          messageId: 'message-reasoning',
          text: 'I should read it.',
          type: 'reasoning',
        },
        {
          arguments: { path: '/tmp/report' },
          at: '2026-01-01T00:00:02.000Z',
          messageId: 'message-call',
          name: 'read_file',
          trackId: 'track-1',
          type: 'toolCall',
        },
        {
          at: '2026-01-01T00:00:03.000Z',
          execution: 'immediate',
          isError: false,
          messageId: 'message-response',
          name: 'read_file',
          text: 'contents',
          trackId: 'track-1',
          type: 'toolResponse',
        },
        {
          at: '2026-01-01T00:00:04.000Z',
          messageId: 'message-assistant',
          text: 'Done.',
          type: 'message',
        },
      ],
      sessionId: 'session-1',
    })

    await session.initialize()

    expect(session.conversationId).toBe('web_previous')
    expect(session.contextUsage).toEqual({
      compactAtTokens: 6_400,
      contextWindow: 10_000,
      usedTokens: 3_300,
    })
    expect(session.items.map((item) => item.kind)).toEqual([
      'user',
      'reasoning',
      'tool',
      'assistant',
      'activity',
    ])
    expect(session.items[session.items.length - 1]).toMatchObject({
      historical: true,
      kind: 'activity',
    })
  })

  it('keeps the current draft when history already contains an earlier reply from the run', async () => {
    vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue([
      {
        agentId: 'assistant',
        conversationId: 'web_active',
        sessionId: 'session-active',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'running',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    ])
    vi.spyOn(chatApi, 'readHistory').mockResolvedValue({
      agentId: 'assistant',
      conversationId: 'web_active',
      entries: [
        {
          at: '2026-01-01T00:00:01.000Z',
          messageId: 'message-first',
          text: 'First tool-loop reply.',
          type: 'message',
        },
      ],
      sessionId: 'session-active',
    })
    vi.spyOn(chatApi, 'openStream').mockImplementation(
      ({ listener, opened, signal }) =>
        new Promise<void>((resolve) => {
          opened('same-backend')
          listener(
            {
              conversationId: 'web_active',
              modelId: 'test-model',
              startedAt: '2026-01-01T00:00:00.000Z',
              trigger: 'user',
              turnId: 'turn-active',
              type: 'runStarted',
            },
            '1',
          )
          listener(
            {
              conversationId: 'web_active',
              text: 'First tool-loop ',
              turnId: 'turn-active',
              type: 'fragment',
            },
            '2',
          )
          listener(
            {
              conversationId: 'web_active',
              text: 'First tool-loop reply.',
              turnId: 'turn-active',
              type: 'message',
            },
            '3',
          )
          listener(
            {
              conversationId: 'web_active',
              text: 'Draft after the tool call.',
              turnId: 'turn-active',
              type: 'fragment',
            },
            '4',
          )
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        }),
    )

    await session.initialize()

    expect(session.items.filter((item) => item.kind === 'assistant')).toMatchObject([
      { streaming: false, text: 'First tool-loop reply.' },
      { streaming: true, text: 'Draft after the tool call.' },
    ])
  })

  it('sends image content without flattening it into the text field', async () => {
    vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue([])
    const sendMessage = vi
      .spyOn(chatApi, 'sendMessage')
      .mockResolvedValue({ messageId: 'message-image' })
    await session.initialize()

    const content = [
      { text: 'Inspect this.', type: 'text' as const },
      {
        source: { type: 'url' as const, url: 'https://images.example.test/object.png' },
        type: 'image' as const,
      },
    ]
    expect(await session.sendContent(content)).toBe(true)

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content, text: 'Inspect this.' }),
    )
    expect(session.items.find((item) => item.kind === 'user')).toMatchObject({
      media: [{ type: 'image' }],
      text: 'Inspect this.',
    })
  })

  it('steers an active run and invokes commands from the published catalog', async () => {
    vi.spyOn(chatApi, 'listCommands').mockResolvedValue([
      { description: 'Stops the run.', name: 'stop', parameters: { type: 'object' } },
    ])
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue([])
    const sendSteer = vi.spyOn(chatApi, 'sendSteer').mockResolvedValue({ messageId: 'steer-1' })
    const submitCommand = vi.spyOn(chatApi, 'submitCommand').mockResolvedValue({ command: 'stop' })

    await session.initialize()
    session.applyEvent({
      conversationId: session.conversationId,
      modelId: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'user',
      turnId: 'turn-1',
      type: 'runStarted',
    })

    expect(session.sendMode).toBe('steer')
    expect(await session.send('Change direction.')).toBe(true)
    expect(sendSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: session.conversationId,
        text: 'Change direction.',
      }),
    )

    expect(await session.invokeCommand('stop', { scope: 'run' })).toBe(true)
    expect(submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { scope: 'run' }, command: 'stop' }),
    )
  })
})
