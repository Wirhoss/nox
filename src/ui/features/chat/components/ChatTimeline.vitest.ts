import { fireEvent, render } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { authApi } from '@/features/auth/api/auth.api'

import { chatApi } from '../api/chat.api'
import { useActiveSessionStore } from '../stores/activeSession.store'
import ChatTimeline from './ChatTimeline.vue'

let auth: ReturnType<typeof useAuthStore>
let session: ReturnType<typeof useActiveSessionStore>

beforeEach(() => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  session = useActiveSessionStore()
  vi.spyOn(chatApi, 'listAgents').mockResolvedValue({ agents: ['nox'], defaultAgent: 'nox' })
})

afterEach(() => {
  session.$dispose()
  auth.$dispose()
  vi.restoreAllMocks()
})

describe('ChatTimeline', () => {
  it('closes a stable response process before showing the assistant reply', async () => {
    const conversationId = session.conversationId
    session.applyEvent({
      conversationId,
      text: 'Inspect first.',
      turnId: 'turn-1',
      type: 'reasoning',
    })
    session.applyEvent({
      arguments: { path: '/tmp/report' },
      conversationId,
      name: 'read_file',
      trackId: 'track-1',
      turnId: 'turn-1',
      type: 'toolCall',
    })
    session.applyEvent({
      conversationId,
      execution: 'immediate',
      isError: true,
      name: 'read_file',
      text: 'File not found.',
      trackId: 'track-1',
      turnId: 'turn-1',
      type: 'toolResponse',
    })
    for (let index = 2; index <= 6; index += 1) {
      session.applyEvent({
        arguments: { index },
        conversationId,
        name: `tool_${String(index)}`,
        trackId: `track-${String(index)}`,
        turnId: 'turn-1',
        type: 'toolCall',
      })
    }
    session.applyEvent({
      conversationId,
      text: 'The report is ready.',
      turnId: 'turn-1',
      type: 'message',
    })
    session.applyEvent({
      conversationId,
      durationMs: 1_250,
      status: 'completed',
      turnId: 'turn-1',
      type: 'runCompleted',
      usage: { inputTokens: 600, outputTokens: 40 },
    })

    const { container } = render(ChatTimeline)
    const response = container.querySelector('.assistant-response')
    const message = response?.querySelector('.message--assistant')
    const process = response?.querySelector<HTMLElement>('.response-process')
    const detailsButton = response?.querySelector<HTMLButtonElement>(
      '.assistant-response__details-summary',
    )
    if (
      response === null ||
      message === null ||
      message === undefined ||
      process === null ||
      process === undefined ||
      detailsButton === null ||
      detailsButton === undefined
    ) {
      throw new Error('Expected a response process followed by the assistant message.')
    }

    expect(process.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(process.nextElementSibling).toBe(message)
    expect(process.querySelectorAll('.response-process__body > details')).toHaveLength(7)
    expect(process.querySelector('.tool--error')).not.toBeNull()
    expect(message.classList.contains('message--embedded')).toBe(true)
    expect(process.closest('.assistant-response')).toBe(message.closest('.assistant-response'))
    expect(detailsButton.textContent).toContain('Details')
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false')
    expect(response.querySelector('.assistant-response__details-body')).toBeNull()

    await fireEvent.click(detailsButton)

    const runDetails = response.querySelector('.assistant-response__details-body')
    expect(detailsButton.getAttribute('aria-expanded')).toBe('true')
    expect(runDetails?.querySelector('.activity--embedded')).not.toBeNull()
    expect(runDetails?.querySelector('.response-process')).toBeNull()
    expect(runDetails?.textContent).toContain('Run completed')
  })

  it('keeps the same process card mounted and closes it when the reply starts', async () => {
    const conversationId = session.conversationId
    session.applyEvent({
      conversationId,
      text: 'Inspecting the current state…',
      turnId: 'turn-stable',
      type: 'reasoningFragment',
    })

    const { container } = render(ChatTimeline)
    const process = container.querySelector<HTMLElement>('.response-process')
    if (process === null) throw new Error('Expected an active response process.')
    const response = process.closest('.assistant-response')
    expect(process.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')

    session.applyEvent({
      conversationId,
      text: 'Inspecting the current state.',
      turnId: 'turn-stable',
      type: 'reasoning',
    })
    session.applyEvent({
      conversationId,
      text: 'Everything is ready.',
      turnId: 'turn-stable',
      type: 'message',
    })
    await nextTick()
    await nextTick()

    const completedProcess = container.querySelector<HTMLElement>('.response-process')
    expect(completedProcess?.closest('.assistant-response')).toBe(response)
    expect(completedProcess).toBe(process)
    expect(completedProcess?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(completedProcess?.nextElementSibling?.classList.contains('message--assistant')).toBe(
      true,
    )
  })

  it('uses a steer marker to cut one response process into two visual segments', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({
      accessToken: 'access-token',
      account: { accountId: 'account-1', createdAt: 1, username: 'operator' },
      expiresInSeconds: 3_600,
    })
    vi.spyOn(chatApi, 'listCommands').mockResolvedValue([])
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue([])
    vi.spyOn(chatApi, 'sendSteer').mockResolvedValue({ messageId: 'steer-1' })
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
    await auth.login({ password: 'secret', username: 'operator' })
    await session.initialize()

    const conversationId = session.conversationId
    session.applyEvent({
      conversationId,
      modelId: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'user',
      turnId: 'turn-steered',
      type: 'runStarted',
    })
    session.applyEvent({
      arguments: { source: 'first' },
      conversationId,
      name: 'inspect_first',
      trackId: 'track-first',
      turnId: 'turn-steered',
      type: 'toolCall',
    })
    expect(await session.send('Use the second source instead.')).toBe(true)
    session.applyEvent({
      arguments: { source: 'second' },
      conversationId,
      name: 'inspect_second',
      trackId: 'track-second',
      turnId: 'turn-steered',
      type: 'toolCall',
    })

    const { container } = render(ChatTimeline)
    const timeline = container.querySelector('.timeline')
    const responses = container.querySelectorAll('.assistant-response')
    const steer = container.querySelector('.message--steer')

    expect(timeline?.children).toHaveLength(3)
    expect(timeline?.children[0]).toBe(responses[0])
    expect(timeline?.children[1]).toBe(steer)
    expect(timeline?.children[2]).toBe(responses[1])
    expect(responses[0]?.classList.contains('assistant-response--redirected')).toBe(true)
    expect(responses[0]?.classList.contains('assistant-response--active')).toBe(false)
    expect(responses[0]?.textContent).toContain('inspect_first')
    expect(responses[0]?.textContent).not.toContain('inspect_second')
    expect(responses[1]?.classList.contains('assistant-response--active')).toBe(true)
    expect(responses[1]?.textContent).toContain('inspect_second')
    expect(responses[1]?.textContent).not.toContain('inspect_first')
  })

  it('unifies consecutive assistant messages into one response bubble', () => {
    const conversationId = session.conversationId
    session.applyEvent({
      conversationId,
      text: 'First part.',
      turnId: 'turn-continuous',
      type: 'message',
    })
    session.applyEvent({
      conversationId,
      text: 'Second part.',
      turnId: 'turn-continuous',
      type: 'message',
    })

    const { container } = render(ChatTimeline)
    const messages = container.querySelectorAll('.message--assistant')

    expect(container.querySelectorAll('.assistant-response')).toHaveLength(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.querySelectorAll('.message__content > .message__text')).toHaveLength(2)
    expect(messages[0]?.textContent).toContain('First part.')
    expect(messages[0]?.textContent).toContain('Second part.')
  })

  it('keeps multiple model cycles in one card while no user message intervenes', () => {
    const conversationId = session.conversationId
    const responses = [
      {
        assistant: 'First result.',
        reasoning: 'Inspect the first source.',
        tool: 'read_first',
        trackId: 'track-first',
        turnId: 'turn-loop-first',
      },
      {
        assistant: 'Second result.',
        reasoning: 'Inspect the second source.',
        tool: 'read_second',
        trackId: 'track-second',
        turnId: 'turn-loop-second',
      },
    ]

    for (const response of responses) {
      session.applyEvent({
        conversationId,
        text: response.reasoning,
        turnId: response.turnId,
        type: 'reasoning',
      })
      session.applyEvent({
        arguments: {},
        conversationId,
        name: response.tool,
        trackId: response.trackId,
        turnId: response.turnId,
        type: 'toolCall',
      })
      session.applyEvent({
        conversationId,
        text: response.assistant,
        turnId: response.turnId,
        type: 'message',
      })
    }
    session.applyEvent({
      conversationId,
      durationMs: 1_250,
      status: 'completed',
      turnId: 'turn-loop-second',
      type: 'runCompleted',
    })

    const { container } = render(ChatTimeline)
    const messages = [...container.querySelectorAll('.message--assistant')]
    const processes = [...container.querySelectorAll('.response-process')]
    expect(container.querySelectorAll('.assistant-response')).toHaveLength(1)
    expect(messages).toHaveLength(2)
    expect(processes).toHaveLength(2)
    expect(container.querySelectorAll('.message__author')).toHaveLength(1)
    expect(container.querySelectorAll('.message__timestamp')).toHaveLength(0)
    expect(container.querySelectorAll('.assistant-response__timestamp')).toHaveLength(1)
    expect(container.querySelector('.assistant-response__footer')?.previousElementSibling).toBe(
      messages[1],
    )

    for (const [index, response] of responses.entries()) {
      const message = messages[index]
      const process = processes[index]
      expect(message?.querySelector('.message__text')?.textContent).toContain(response.assistant)
      expect(process?.querySelectorAll('.response-process__body > details')).toHaveLength(2)
      expect(process?.textContent).toContain(response.reasoning)
      expect(process?.textContent).toContain(response.tool)
      expect(process?.textContent).not.toContain(responses[1 - index]?.tool)
      expect(process?.nextElementSibling).toBe(message)
    }

    expect(messages[0]?.querySelector('.message__details-summary')).toBeNull()
    expect(messages[1]?.querySelector('.message__details-summary')).toBeNull()
    expect(container.querySelectorAll('.assistant-response__details-summary')).toHaveLength(1)
  })
})
