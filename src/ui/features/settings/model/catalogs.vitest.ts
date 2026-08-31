import { describe, expect, it } from 'vitest'

import { modelCatalogProblem, modelOptions, providerOptions } from './catalogs'

import type { ProviderInventory } from '../api/settings.api'

/** A message key echoed back, so a test asserts which answer was given. */
function t(key: string, parameters: Readonly<Record<string, boolean | number | string>> = {}) {
  const rendered = Object.entries(parameters)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(',')
  return rendered.length === 0 ? key : `${key}(${rendered})`
}

const INVENTORY: readonly ProviderInventory[] = [
  {
    available: true,
    id: 'main',
    kinds: ['chat'],
    models: [
      { configured: false, modelId: 'listed-only' },
      { configured: true, kind: 'chat', modelId: 'declared' },
    ],
    reported: true,
    type: 'openai_completions',
  },
  {
    available: false,
    id: 'broken',
    kinds: [],
    models: [],
    problem: 'the endpoint refused the credential',
    reported: false,
    type: 'openai_completions',
  },
  {
    available: true,
    id: 'silent',
    kinds: ['chat'],
    models: [],
    reported: false,
    reportProblem: 'no /models endpoint',
    type: 'openai_completions',
  },
]

describe('providerOptions', () => {
  it('offers a provider that failed to activate, and says that it did', () => {
    expect(providerOptions(INVENTORY, t)).toEqual([
      { note: 'openai_completions', value: 'main' },
      { note: 'settings.catalog.providerUnavailable', value: 'broken' },
      { note: 'openai_completions', value: 'silent' },
    ])
  })
})

describe('modelOptions', () => {
  it('puts declared models first and marks what the endpoint merely reported', () => {
    expect(modelOptions(INVENTORY, 'main', t)).toEqual([
      { note: 'settings.catalog.chat', value: 'declared' },
      { note: 'settings.catalog.reported', value: 'listed-only' },
    ])
  })

  it('offers nothing until a provider is named', () => {
    expect(modelOptions(INVENTORY, undefined, t)).toEqual([])
    expect(modelOptions(INVENTORY, '', t)).toEqual([])
  })
})

describe('modelCatalogProblem', () => {
  it('says why there is nothing to choose from, rather than showing an empty list', () => {
    expect(modelCatalogProblem(INVENTORY, undefined, t)).toBe(
      'settings.catalog.chooseProviderFirst',
    )
    expect(modelCatalogProblem(INVENTORY, 'absent', t)).toBe(
      'settings.catalog.unknownProvider(provider=absent)',
    )
    expect(modelCatalogProblem(INVENTORY, 'broken', t)).toBe(
      'settings.catalog.providerProblem(problem=the endpoint refused the credential)',
    )
    expect(modelCatalogProblem(INVENTORY, 'silent', t)).toBe(
      'settings.catalog.modelsUnlistable(problem=no /models endpoint)',
    )
  })

  it('stays quiet when the catalog has something to offer', () => {
    expect(modelCatalogProblem(INVENTORY, 'main', t)).toBeUndefined()
  })
})
