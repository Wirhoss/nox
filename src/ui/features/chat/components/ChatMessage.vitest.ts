import { render } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ChatMessage from './ChatMessage.vue'

describe('ChatMessage', () => {
  it('shows the message date and time below its content', () => {
    const createdAt = '2026-03-10T14:35:00.000Z'
    const { container } = render(ChatMessage, {
      props: {
        item: {
          createdAt,
          id: 'message-1',
          kind: 'assistant',
          media: [],
          streaming: false,
          text: 'Done.',
          turnId: 'turn-1',
        },
      },
    })

    const timestamp = container.querySelector('time')
    if (timestamp === null) throw new Error('Expected a message timestamp.')

    expect(timestamp.getAttribute('datetime')).toBe(createdAt)
    expect(timestamp.textContent.trim()).not.toBe('')
    expect(timestamp.parentElement?.classList.contains('message__footer')).toBe(true)
    expect(
      timestamp.parentElement?.previousElementSibling?.classList.contains('message__content'),
    ).toBe(true)
  })

  it('keeps generated artifacts at their position between text parts', () => {
    const { container } = render(ChatMessage, {
      props: {
        item: {
          content: [
            { text: 'Before the artifact.', type: 'text' },
            {
              source: { type: 'url', url: 'https://images.example.test/generated.png' },
              type: 'image',
            },
            { text: 'After the artifact.', type: 'text' },
          ],
          createdAt: '2026-03-10T14:35:00.000Z',
          id: 'message-artifact',
          kind: 'assistant',
          media: [
            {
              source: { type: 'url', url: 'https://images.example.test/generated.png' },
              type: 'image',
            },
          ],
          streaming: false,
          text: 'Before the artifact.After the artifact.',
          turnId: 'turn-artifact',
        },
      },
    })

    const parts = [...container.querySelectorAll('.message__content > *')]
    expect(parts).toHaveLength(3)
    expect(parts[0]?.textContent).toContain('Before the artifact.')
    expect(parts[1]?.querySelector('img')?.getAttribute('src')).toBe(
      'https://images.example.test/generated.png',
    )
    expect(parts[2]?.textContent).toContain('After the artifact.')
  })

  it('renders image content instead of reducing it to a placeholder', () => {
    const { container } = render(ChatMessage, {
      props: {
        item: {
          createdAt: '2026-03-10T14:35:00.000Z',
          id: 'message-image',
          kind: 'user',
          media: [
            {
              source: { type: 'url', url: 'https://images.example.test/object.png' },
              type: 'image',
            },
          ],
          mode: 'message',
          text: 'What is this?',
        },
      },
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://images.example.test/object.png',
    )
    expect(container.querySelector('.message__text')?.textContent).toContain('What is this?')
  })

  it('renders a steer as an explicit response redirect instead of a normal message', () => {
    const { container } = render(ChatMessage, {
      props: {
        item: {
          createdAt: '2026-03-10T14:35:00.000Z',
          id: 'steer-1',
          kind: 'user',
          media: [],
          mode: 'steer',
          steeredTurnId: 'turn-1',
          text: 'Use the second approach instead.',
        },
      },
    })

    expect(container.querySelector('.message--steer')).not.toBeNull()
    expect(container.querySelector('.message__steer-label')?.textContent).toContain(
      'RESPONSE REDIRECTED',
    )
  })
})
