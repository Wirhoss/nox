import { describe, expect, it } from 'vitest'

import { defaultFor, fieldsOf, optionsOf, parseInput, seedArguments } from './commandForm'

describe('command schema forms', () => {
  it('seeds required fields and declared defaults without inventing optional arguments', () => {
    const schema = {
      properties: {
        enabled: { default: true, type: 'boolean' },
        note: { type: 'string' },
        retries: { minimum: 1, type: 'integer' },
      },
      required: ['retries'],
      type: 'object',
    }

    expect(seedArguments(schema)).toEqual({ enabled: true, retries: 1 })
    expect(fieldsOf(schema).map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'enabled', required: false },
      { name: 'note', required: false },
      { name: 'retries', required: true },
    ])
  })

  it('builds nested required objects and preserves enum value types', () => {
    const nested = {
      properties: { count: { type: 'number' } },
      required: ['count'],
      type: 'object',
    }

    expect(defaultFor(nested)).toEqual({ count: 0 })
    expect(optionsOf({ enum: [1, 2], type: 'number' })).toEqual([1, 2])
    expect(parseInput('2.5', { type: 'number' })).toBe(2.5)
  })
})
