import { fireEvent, render } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ReasoningActivityCard from './ReasoningActivityCard.vue'

describe('ReasoningActivityCard', () => {
  it('lets settled reasoning stay open after the user expands it', async () => {
    const { container } = render(ReasoningActivityCard, {
      props: {
        item: {
          id: 'reasoning-1',
          kind: 'reasoning',
          streaming: false,
          text: 'Inspect the current state.',
          turnId: 'turn-1',
        },
      },
    })

    const details = container.querySelector<HTMLDetailsElement>('details.reasoning')
    if (details === null) throw new Error('Expected reasoning details.')

    expect(details.open).toBe(false)
    expect(details.querySelector('.reasoning__chevron')).not.toBeNull()

    const summary = details.querySelector('summary')
    if (summary === null) throw new Error('Expected a reasoning summary.')
    await fireEvent.click(summary)

    expect(details.open).toBe(true)
  })

  it('keeps streaming reasoning expanded and collapses it when it settles', async () => {
    const item = {
      id: 'reasoning-2',
      kind: 'reasoning' as const,
      streaming: true,
      text: 'Inspecting…',
      turnId: 'turn-1',
    }
    const view = render(ReasoningActivityCard, { props: { item } })

    expect(view.container.querySelector<HTMLDetailsElement>('details.reasoning')?.open).toBe(true)

    await view.rerender({ item: { ...item, streaming: false } })

    expect(view.container.querySelector<HTMLDetailsElement>('details.reasoning')?.open).toBe(false)
  })
})
