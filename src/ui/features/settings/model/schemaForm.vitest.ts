import { describe, expect, it } from 'vitest'

import {
  activeFields,
  type FieldNode,
  formNodes,
  type JsonSchema,
  listEntryDefaults,
  listEntryNodes,
  type ListNode,
  mapEntryDefaults,
  mapEntryNodes,
  type MapNode,
  seedNode,
  valueAt,
  variantAt,
  withoutKey,
  withRenamedKey,
  withValueAt,
} from './schemaForm'

/** A record whose keys an operator writes, shaped like Discord's admitted channels. */
const schema: JsonSchema = {
  properties: {
    channels: {
      additionalProperties: {
        additionalProperties: false,
        properties: {
          observe: { default: 'none', enum: ['channel', 'none'], type: 'string' },
          threads: { default: 'inherit', enum: ['ignore', 'inherit'], type: 'string' },
        },
        type: 'object',
      },
      default: {},
      propertyNames: { pattern: '^[0-9]{17,20}$', type: 'string' },
      type: 'object',
    },
    // A strict object: `additionalProperties: false` is a boolean, not a schema,
    // and must not read as a map of nothing.
    verbose: {
      additionalProperties: false,
      properties: { runs: { default: false, type: 'boolean' } },
      type: 'object',
    },
  },
  type: 'object',
}

function channelsNode(): MapNode {
  const node = formNodes(schema, []).find((candidate) => candidate.name === 'channels')
  if (node?.kind !== 'map') throw new Error('channels did not read as a map')
  return node
}

function namedField(root: JsonSchema, name: string): FieldNode {
  const node = formNodes(root, []).find((candidate) => candidate.name === name)
  if (node?.kind !== 'field') throw new Error(`${name} did not read as a field`)
  return node
}

function modelListNode(): ListNode {
  const modelSchema: JsonSchema = {
    properties: {
      models: {
        items: {
          anyOf: [
            {
              properties: {
                contextWindow: { default: 4096, type: 'number' },
                kind: { const: 'chat', type: 'string' },
                modelId: { type: 'string' },
              },
              type: 'object',
            },
            {
              properties: {
                dimensions: { default: 384, type: 'number' },
                kind: { const: 'embedding', type: 'string' },
                modelId: { type: 'string' },
              },
              type: 'object',
            },
          ],
        },
        type: 'array',
      },
    },
    type: 'object',
  }
  const node = formNodes(modelSchema, []).find((candidate) => candidate.name === 'models')
  if (node?.kind !== 'list') throw new Error('models did not read as a list')
  return node
}

describe('formNodes', () => {
  it('reads a record as a map, carrying what its keys must look like', () => {
    expect(channelsNode().keyPattern).toBe('^[0-9]{17,20}$')
  })

  it('leaves a strict object an object rather than an empty map', () => {
    const node = formNodes(schema, []).find((candidate) => candidate.name === 'verbose')
    expect(node?.kind).toBe('object')
  })

  it('edits a list of objects as entries with fields, not as comma-separated text', () => {
    const arraySchema: JsonSchema = {
      properties: {
        models: {
          items: {
            properties: { modelId: { type: 'string' } },
            type: 'object',
          },
          type: 'array',
        },
        names: { items: { type: 'string' }, type: 'array' },
      },
      type: 'object',
    }

    // Commas printed these as `[object Object]`, and editing the field replaced
    // the entries with the strings they had been printed as.
    const models = formNodes(arraySchema, []).find((node) => node.name === 'models')
    expect(models?.kind).toBe('list')
    expect(models?.kind === 'list' && listEntryNodes(models, 0).map((child) => child.path)).toEqual(
      [['models', '0', 'modelId']],
    )
    expect(namedField(arraySchema, 'names').control).toBe('list')
    expect(namedField(arraySchema, 'names').kind).toBe('field')
  })

  it('gives an entry that is a choice between shapes its fields, not an empty box', () => {
    // The shape `modelConfigs` actually has. Written flat before, this passed
    // while the real form rendered an entry with nothing in it.
    const unionItems: JsonSchema = {
      properties: {
        models: {
          items: {
            anyOf: [
              {
                properties: {
                  contextWindow: { type: 'number' },
                  kind: { const: 'chat', type: 'string' },
                  modelId: { type: 'string' },
                },
                type: 'object',
              },
              {
                properties: {
                  dimensions: { type: 'number' },
                  kind: { const: 'embedding', type: 'string' },
                  modelId: { type: 'string' },
                },
                type: 'object',
              },
            ],
          },
          type: 'array',
        },
      },
      type: 'object',
    }

    const models = formNodes(unionItems, []).find((node) => node.name === 'models')
    if (models?.kind !== 'list') throw new Error('Expected a list node.')
    const [entry] = listEntryNodes(models, 0)
    if (entry?.kind !== 'variant') throw new Error('Expected the entry to be a variant.')

    expect(entry.discriminator).toBe('kind')
    expect(entry.path).toEqual(['models', '0'])
    expect(entry.variants.map((variant) => variant.value)).toEqual(['chat', 'embedding'])
    expect(entry.variants[0]?.children.map((child) => child.path)).toEqual([
      ['models', '0', 'contextWindow'],
      ['models', '0', 'modelId'],
    ])
    // Added without its discriminator, the entry would render a selector over
    // nothing and save as a shape the schema does not have.
    expect(listEntryDefaults(models)).toMatchObject({ kind: 'chat' })
  })

  it('treats a list of union branches as a list, whatever its branches are', () => {
    const unionSchema: JsonSchema = {
      properties: {
        models: {
          items: {
            anyOf: [
              { properties: { contextWindow: { type: 'number' } }, type: 'object' },
              { properties: { dimensions: { type: 'number' } }, type: 'object' },
            ],
          },
          type: 'array',
        },
      },
      type: 'object',
    }

    const models = formNodes(unionSchema, []).find((node) => node.name === 'models')
    expect(models?.kind).toBe('list')
  })

  it('carries enum option message keys only where metadata supplies them', () => {
    const enumSchema: JsonSchema = {
      properties: {
        labeled: {
          enum: ['mention', 'reply'],
          nox: { options: { mention: 'ui.trigger.mention', reply: false } },
          type: 'string',
        },
        plain: { enum: ['channel', 'none'], type: 'string' },
      },
      type: 'object',
    }

    expect(namedField(enumSchema, 'labeled').options).toEqual([
      { label: 'mention', messageKey: 'ui.trigger.mention', value: 'mention' },
      { label: 'reply', value: 'reply' },
    ])
    expect(namedField(enumSchema, 'plain').options).toEqual([
      { label: 'channel', value: 'channel' },
      { label: 'none', value: 'none' },
    ])
  })

  it('uses checklists for closed enum arrays and lists for free-form arrays', () => {
    const arraySchema: JsonSchema = {
      properties: {
        choices: { items: { enum: ['one', 'two'], type: 'string' }, type: 'array' },
        entries: { items: { type: 'string' }, type: 'array' },
      },
      type: 'object',
    }

    expect(namedField(arraySchema, 'choices')).toMatchObject({
      control: 'checklist',
      options: [
        { label: 'one', value: 'one' },
        { label: 'two', value: 'two' },
      ],
    })
    expect(namedField(arraySchema, 'entries')).toMatchObject({ control: 'list', options: [] })
  })

  it('takes enum array option labels from the array rather than its items', () => {
    const arraySchema: JsonSchema = {
      properties: {
        choices: {
          items: {
            enum: ['one'],
            nox: { options: { one: 'ui.item.one' } },
            type: 'string',
          },
          nox: { options: { one: 'ui.array.one' } },
          type: 'array',
        },
      },
      type: 'object',
    }

    expect(namedField(arraySchema, 'choices').options).toEqual([
      { label: 'one', messageKey: 'ui.array.one', value: 'one' },
    ])
  })

  it('carries an array minimum into its field node', () => {
    const arraySchema: JsonSchema = {
      properties: {
        choices: { items: { enum: ['one'], type: 'string' }, minItems: 1, type: 'array' },
      },
      type: 'object',
    }

    expect(namedField(arraySchema, 'choices').minItems).toBe(1)
  })
})

describe('mapEntryNodes', () => {
  it('paths one entry through the key it is filed under', () => {
    expect(mapEntryNodes(channelsNode(), '123').map((node) => node.path.join('.'))).toEqual([
      'channels.123.observe',
      'channels.123.threads',
    ])
  })

  it('starts a new entry from the defaults its value schema declared', () => {
    expect(mapEntryDefaults(channelsNode())).toEqual({ observe: 'none', threads: 'inherit' })
  })
})

describe('activeFields', () => {
  it('walks the entries the value happens to hold', () => {
    const value = { channels: { '123': { observe: 'none' }, '456': { observe: 'channel' } } }
    expect(activeFields([channelsNode()], value).map((field) => field.path.join('.'))).toEqual([
      'channels.123.observe',
      'channels.123.threads',
      'channels.456.observe',
      'channels.456.threads',
    ])
  })

  it('walks the selected shape of every structured list entry', () => {
    const value = {
      models: [
        { kind: 'chat', modelId: 'chat/model' },
        { dimensions: 384, kind: 'embedding', modelId: 'embed/model' },
      ],
    }
    expect(activeFields([modelListNode()], value).map((field) => field.path.join('.'))).toEqual([
      'models.0.contextWindow',
      'models.0.modelId',
      'models.1.dimensions',
      'models.1.modelId',
    ])
  })
})

describe('nested value paths', () => {
  it('reads and immutably updates fields inside arrays without turning them into records', () => {
    const original = { models: [{ kind: 'chat', modelId: 'old/model' }] }
    const updated = withValueAt(original, ['models', '0', 'modelId'], 'new/model')

    expect(updated).toEqual({ models: [{ kind: 'chat', modelId: 'new/model' }] })
    expect(valueAt(updated, ['models', '0', 'modelId'])).toBe('new/model')
    expect(Array.isArray(updated.models)).toBe(true)
    expect(original).toEqual({ models: [{ kind: 'chat', modelId: 'old/model' }] })
  })

  it('finds and reseeds a variant nested in a dynamic list entry', () => {
    const models = modelListNode()
    const variant = variantAt([models], ['models', '0', 'kind'])
    if (variant === undefined) throw new Error('Expected the model variant.')

    const original = {
      models: [{ contextWindow: 8192, kind: 'chat', modelId: 'old/model' }],
    }
    const updated = withValueAt(original, variant.path, seedNode(variant, 'embedding'))

    expect(updated).toEqual({ models: [{ dimensions: 384, kind: 'embedding' }] })
    expect(original.models[0]).toHaveProperty('contextWindow', 8192)
  })
})

describe('withRenamedKey', () => {
  it('renames in place, so an entry does not move while its key is typed', () => {
    expect(Object.keys(withRenamedKey({ a: 1, b: 2, c: 3 }, 'b', 'zz'))).toEqual(['a', 'zz', 'c'])
  })

  it('refuses to rename onto a key that already exists', () => {
    expect(withRenamedKey({ a: 1, b: 2 }, 'a', 'b')).toEqual({ a: 1, b: 2 })
  })
})

describe('withoutKey', () => {
  it('drops one entry and keeps the rest', () => {
    expect(withoutKey({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 })
  })
})
