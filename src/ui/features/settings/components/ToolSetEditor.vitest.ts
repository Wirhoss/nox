import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'

import ToolSetEditor from './ToolSetEditor.vue'

const settings = vi.hoisted(() => ({
  clearMutation: vi.fn(),
  contributionTypes: [
    {
      extensionId: 'test.first',
      instances: 'single' as const,
      schema: {
        properties: {
          fromFirstSchema: { default: 'wrong', type: 'string' },
          type: { const: 'first', type: 'string' },
        },
        required: ['type'],
        type: 'object',
      },
      type: 'first',
    },
    {
      extensionId: 'test.selected',
      instances: 'single' as const,
      schema: {
        properties: {
          fromSelectedSchema: { default: 'right', type: 'string' },
          type: { const: 'selected', type: 'string' },
        },
        required: ['type'],
        type: 'object',
      },
      type: 'selected',
    },
  ],
  mutation: { type: 'idle' as const },
  secrets: [],
  toolSetInventory: [],
}))

vi.mock('../stores/settings.store', () => ({ useSettingsStore: () => settings }))
vi.mock('vue-router', async (importOriginal) => {
  const original = await importOriginal<typeof import('vue-router')>()
  return {
    ...original,
    onBeforeRouteLeave: vi.fn(),
    onBeforeRouteUpdate: vi.fn(),
  }
})

describe('ToolSetEditor', () => {
  it('seeds a contributed instance from the selected type, not the first registered type', async () => {
    render(ToolSetEditor, {
      props: {
        creating: true,
        definition: {
          creatable: false,
          description: 'settings.sections.toolSets.description',
          editor: 'toolSet',
          group: 'capabilities',
          key: 'toolSets',
          label: 'settings.sections.toolSets.label',
          plural: 'settings.sections.toolSets.plural',
          slug: 'tool-sets',
        },
        presetType: 'selected',
        section: {
          applies: 'hot',
          creatable: false,
          description: 'settings.sections.toolSets.description',
          editor: 'toolSet',
          entries: true,
          group: 'capabilities',
          key: 'toolSets',
          kind: 'contribution',
          label: 'settings.sections.toolSets.label',
          loaded: true,
          name: 'toolsets.json',
          plural: 'settings.sections.toolSets.plural',
          references: [],
          slug: 'tool-sets',
          value: {},
          writable: true,
        },
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'JSON' }))

    expect(screen.getByLabelText('JSON object')).toHaveProperty(
      'value',
      '{\n  "fromSelectedSchema": "right"\n}',
    )
  })
})
