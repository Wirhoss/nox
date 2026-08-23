import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ToolActivityCard from './ToolActivityCard.vue'

describe('ToolActivityCard', () => {
  it('collapses the whole tool and keeps disclosure arrows and result tone', () => {
    const { container } = render(ToolActivityCard, {
      props: {
        item: {
          arguments: { path: '/tmp/report' },
          id: 'tool-turn-1-read',
          kind: 'tool',
          name: 'read_file',
          responses: [
            {
              execution: 'immediate',
              id: 'response-1',
              isError: true,
              media: [],
              text: 'File not found.',
            },
          ],
          trackId: 'read',
          turnId: 'turn-1',
        },
      },
    })

    const toolDetails = container.querySelector<HTMLDetailsElement>('details.tool')
    const argumentsDetails = screen.getByText('Arguments').closest('details')
    const resultDetails = screen.getByText('Result').closest('details')

    expect(toolDetails?.open).toBe(false)
    expect(toolDetails?.querySelector(':scope > summary .tool__chevron')).not.toBeNull()
    expect(argumentsDetails?.open).toBe(false)
    expect(resultDetails?.open).toBe(false)
    expect(resultDetails?.querySelector('.tool__chevron')).not.toBeNull()
    expect(resultDetails?.classList.contains('tool__result--error')).toBe(true)
    expect(container.querySelector('.tool--error')).not.toBeNull()
  })
})
