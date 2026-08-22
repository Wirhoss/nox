import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import ContextGauge from './ContextGauge.vue'

describe('ContextGauge', () => {
  it('draws the percentage from runtime-owned context accounting', () => {
    const { container } = render(ContextGauge, {
      props: {
        usage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
      },
    })

    const meter = screen.getByRole('meter', { name: 'Context window' })
    expect(meter.getAttribute('aria-valuenow')).toBe('3200')
    expect(meter.getAttribute('aria-valuemax')).toBe('10000')
    expect(meter.getAttribute('aria-valuetext')).toContain('32 percent full')
    expect(container.querySelector('.context-gauge__value')?.getAttribute('stroke-dasharray')).toBe(
      '32 100',
    )
    expect(screen.getByText('3.2K / 10K')).toBeTruthy()
  })

  it('stays honest when the provider did not declare a context window', () => {
    render(ContextGauge, { props: { usage: { usedTokens: 900 } } })

    const meter = screen.getByRole('meter', { name: 'Context window' })
    expect(meter.getAttribute('aria-valuetext')).toContain('capacity is unknown')
    expect(screen.getByText('900 tokens')).toBeTruthy()
    expect(screen.getByText('— CTX')).toBeTruthy()
  })
})
