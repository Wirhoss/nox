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
    expect(timestamp.parentElement?.previousElementSibling?.classList.contains('message__text')).toBe(
      true,
    )
  })
})
