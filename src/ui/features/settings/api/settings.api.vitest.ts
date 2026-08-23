import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/tests/server'

import { settingsApi } from './settings.api'

const TOKEN = 'settings-access-token'

describe('settings API', () => {
  it('reads the unified configuration catalog', async () => {
    server.use(
      http.get('*/api/config', ({ request }) => {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        return HttpResponse.json({
          defaultAgent: 'nox',
          sections: [
            {
              applies: 'restart',
              entries: true,
              key: 'blueprints',
              kind: 'directory',
              loaded: true,
              name: 'blueprints',
              writable: false,
            },
          ],
        })
      }),
    )

    const catalog = await settingsApi.listConfig(TOKEN)

    expect(catalog.defaultAgent).toBe('nox')
    expect(catalog.sections[0]).toMatchObject({ entries: true, key: 'blueprints' })
  })

  it('reads the runtime tool inventory for Agent grants', async () => {
    server.use(
      http.get('*/api/capabilities/tool-sets', ({ request }) => {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        return HttpResponse.json({
          toolSets: [
            {
              available: true,
              description: 'Public web capabilities.',
              id: 'internet',
              name: 'Web tools',
              tools: [
                {
                  authority: 'nox.toolset.web.search',
                  description: 'Search the public web.',
                  name: 'web_search',
                },
              ],
              type: 'web',
            },
          ],
        })
      }),
    )

    const inventory = await settingsApi.listToolSetInventory(TOKEN)

    expect(inventory).toEqual([
      expect.objectContaining({
        available: true,
        id: 'internet',
        tools: [expect.objectContaining({ name: 'web_search' })],
      }),
    ])
  })

  it('writes a secret without expecting its value back', async () => {
    server.use(
      http.put('*/api/secrets/OPENAI_API_KEY', async ({ request }) => {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(await request.json()).toEqual({ value: 'never-return-this' })
        return HttpResponse.json({
          consumers: [],
          createdAt: 10,
          references: [{ location: 'providers.main.apiKey', secretId: 'OPENAI_API_KEY' }],
          restartRequired: false,
          secretId: 'OPENAI_API_KEY',
          stored: true,
          updatedAt: 10,
        })
      }),
    )

    const secret = await settingsApi.saveSecret({
      accessToken: TOKEN,
      secretId: 'OPENAI_API_KEY',
      value: 'never-return-this',
    })

    expect(secret).toEqual({
      consumers: [],
      createdAt: 10,
      references: [{ location: 'providers.main.apiKey', secretId: 'OPENAI_API_KEY' }],
      restartRequired: false,
      secretId: 'OPENAI_API_KEY',
      stored: true,
      updatedAt: 10,
    })
    expect('value' in secret).toBe(false)
  })

  it('preserves actionable refusal details from configuration writes', async () => {
    server.use(
      http.delete('*/api/config/providers/main', () =>
        HttpResponse.json(
          {
            detail: '"main" cannot be removed from providers.json.',
            error: 'entry_in_use',
            reasons: ['blueprints/nox.json names it.'],
          },
          { status: 409 },
        ),
      ),
    )

    await expect(
      settingsApi.deleteEntry({ accessToken: TOKEN, entryId: 'main', section: 'providers' }),
    ).rejects.toMatchObject({
      code: 'entry_in_use',
      detail: '"main" cannot be removed from providers.json.',
      reasons: ['blueprints/nox.json names it.'],
      status: 409,
    })
  })
})
