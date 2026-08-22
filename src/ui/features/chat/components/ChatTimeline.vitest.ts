import { fireEvent, render } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useActiveSessionStore } from '../stores/activeSession.store'
import ChatTimeline from './ChatTimeline.vue'

let session: ReturnType<typeof useActiveSessionStore>

beforeEach(() => {
  setActivePinia(createPinia())
  session = useActiveSessionStore()
})

afterEach(() => {
  session.$dispose()
})

describe('ChatTimeline', () => {
  it('integrates response work and run details into the assistant reply', async () => {
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
    const message = container.querySelector('.message--assistant')
    const process = message?.querySelector<HTMLDetailsElement>(':scope > .message__process')
    const detailsButton = message?.querySelector<HTMLButtonElement>('.message__details-summary')
    if (message === null || process === null || process === undefined || detailsButton === null || detailsButton === undefined) {
      throw new Error('Expected process and run controls inside the assistant message.')
    }

    expect(container.querySelector('.timeline__process')).toBeNull()
    expect(process.nextElementSibling?.classList.contains('message__author')).toBe(true)
    expect(process.querySelectorAll('.message__process-body > details')).toHaveLength(7)
    expect(process.querySelector('.tool--error')).not.toBeNull()
    expect(detailsButton.textContent).toContain('Details')
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false')
    expect(message.querySelector('.message__details-body')).toBeNull()

    await fireEvent.click(detailsButton)

    const runDetails = message.querySelector('.message__details-body')
    expect(detailsButton.getAttribute('aria-expanded')).toBe('true')
    expect(runDetails?.querySelector('.activity--embedded')).not.toBeNull()
    expect(runDetails?.querySelector('.message__process')).toBeNull()
    expect(runDetails?.textContent).toContain('Run completed')
  })

  it('associates each response process with its assistant inside one tool loop', () => {
    const conversationId = session.conversationId
    const responses = [
      {
        assistant: 'First result.',
        reasoning: 'Inspect the first source.',
        tool: 'read_first',
        trackId: 'track-first',
      },
      {
        assistant: 'Second result.',
        reasoning: 'Inspect the second source.',
        tool: 'read_second',
        trackId: 'track-second',
      },
    ]

    for (const response of responses) {
      session.applyEvent({
        conversationId,
        text: response.reasoning,
        turnId: 'turn-loop',
        type: 'reasoning',
      })
      session.applyEvent({
        arguments: {},
        conversationId,
        name: response.tool,
        trackId: response.trackId,
        turnId: 'turn-loop',
        type: 'toolCall',
      })
      session.applyEvent({
        conversationId,
        text: response.assistant,
        turnId: 'turn-loop',
        type: 'message',
      })
    }
    session.applyEvent({
      conversationId,
      durationMs: 1_250,
      status: 'completed',
      turnId: 'turn-loop',
      type: 'runCompleted',
    })

    const { container } = render(ChatTimeline)
    const messages = [...container.querySelectorAll('.message--assistant')]
    expect(messages).toHaveLength(2)
    expect(container.querySelector('.timeline__process')).toBeNull()

    for (const [index, response] of responses.entries()) {
      const message = messages[index]
      const process = message?.querySelector(':scope > .message__process')
      expect(message?.querySelector('.message__text')?.textContent).toContain(response.assistant)
      expect(process?.querySelectorAll('.message__process-body > details')).toHaveLength(2)
      expect(process?.textContent).toContain(response.reasoning)
      expect(process?.textContent).toContain(response.tool)
      expect(process?.textContent).not.toContain(responses[1 - index]?.tool)
    }

    expect(messages[0]?.querySelector('.message__details-summary')).toBeNull()
    expect(messages[1]?.querySelector('.message__details-summary')).not.toBeNull()
  })
})
