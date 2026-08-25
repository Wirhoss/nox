import { fireEvent, render } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/app/stores/auth.store'
import { authApi } from '@/features/auth/api/auth.api'

import { chatApi } from '../api/chat.api'
import { useActiveSessionStore } from '../stores/activeSession.store'
import ConversationList from './ConversationList.vue'

let auth: ReturnType<typeof useAuthStore>
let session: ReturnType<typeof useActiveSessionStore>

beforeEach(async () => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  session = useActiveSessionStore()

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
  vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
})

afterEach(() => {
  session.$dispose()
  auth.$dispose()
  vi.restoreAllMocks()
})

describe('ConversationList', () => {
  it('filters previous conversations by title, agent and conversation ID', async () => {
    const conversations = [
      {
        agentId: 'analyst',
        conversationId: 'web_quarterly',
        sessionId: 'session-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'closed' as const,
        title: 'Quarterly report',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        agentId: 'Writer',
        conversationId: 'web_draft',
        sessionId: 'session-2',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'idle' as const,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        agentId: 'operator',
        conversationId: 'web_target42',
        sessionId: 'session-3',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'running' as const,
        title: 'Deployment',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    const latest = conversations[0]
    if (latest === undefined) throw new Error('Expected a latest conversation fixture.')

    vi.spyOn(chatApi, 'listConversations').mockResolvedValue(conversations)
    vi.spyOn(chatApi, 'readHistory').mockResolvedValue({
      agentId: latest.agentId,
      conversationId: latest.conversationId,
      entries: [],
      sessionId: latest.sessionId,
    })
    await session.initialize()

    const view = render(ConversationList)
    const search = view.getByRole('searchbox', { name: 'Find a conversation' })
    const visibleConversations = () => view.container.querySelectorAll('ol > li')

    expect(visibleConversations()).toHaveLength(3)

    await fireEvent.update(search, 'quarterly')
    expect(visibleConversations()).toHaveLength(1)
    expect(view.getByText('Quarterly report')).toBeTruthy()

    await fireEvent.update(search, 'writer')
    expect(visibleConversations()).toHaveLength(1)
    expect(view.getByText('Writer')).toBeTruthy()

    await fireEvent.update(search, 'target42')
    expect(visibleConversations()).toHaveLength(1)
    expect(view.getByText('Deployment')).toBeTruthy()

    await fireEvent.update(search, 'missing')
    expect(visibleConversations()).toHaveLength(0)
    expect(view.getByText('No matching conversations.')).toBeTruthy()
  })
})
