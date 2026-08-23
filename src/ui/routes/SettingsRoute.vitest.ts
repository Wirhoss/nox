import { fireEvent, render, screen, waitFor, within } from '@testing-library/vue'
import { http, HttpResponse } from 'msw'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import App from '@/app/App.vue'
import router from '@/app/router'
import { server } from '@/tests/server'

describe('Settings route', () => {
  it('edits machine-level settings through the curated General workbench', async () => {
    let savedBody: unknown
    const app = {
      api: { host: '127.0.0.1', port: 8080 },
      auth: {
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
        secureCookies: false,
      },
      chat: { defaultAgent: 'nox' },
      database: { busyTimeoutMs: 5000, path: 'state/nox.db', synchronous: 'normal' },
      logLevel: 'info',
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          defaultAgent: 'nox',
          sections: [
            sectionSummary('app', 'file', false, 'app.json', true),
            sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          ],
        }),
      ),
      http.get('*/api/config/app', () =>
        HttpResponse.json({
          ...sectionSummary('app', 'file', false, 'app.json', true),
          value: app,
        }),
      ),
      http.get('*/api/config/blueprints', () =>
        HttpResponse.json({
          ...sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          value: {
            nox: { model: 'main', provider: 'main', systemPrompt: 'Primary' },
            support: { model: 'main', provider: 'main', systemPrompt: 'Support' },
          },
        }),
      ),
      http.put('*/api/config/app', async ({ request }) => {
        savedBody = await request.json()
        return HttpResponse.json({
          ...sectionSummary('app', 'file', false, 'app.json', true),
          restartRequired: true,
          value: savedBody,
        })
      }),
    )

    await renderAt('/settings/general')

    expect(await screen.findByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByLabelText(/^Bind host/)).toHaveProperty('value', '127.0.0.1')
    expect(screen.getByLabelText(/^Default agent/)).toHaveProperty('value', 'nox')
    expect(screen.getByLabelText(/^Database path/)).toHaveProperty('value', 'state/nox.db')
    expect(screen.getByRole('checkbox', { name: /Secure refresh cookies/ })).toHaveProperty(
      'checked',
      false,
    )

    await fireEvent.update(screen.getByLabelText(/^Bind host/), '0.0.0.0')
    await fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(screen.getByLabelText('JSON object')).toHaveProperty(
      'value',
      expect.stringContaining('"host": "0.0.0.0"'),
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Form' }))
    await fireEvent.update(screen.getByLabelText(/^Default agent/), 'support')
    await fireEvent.update(screen.getByLabelText(/^Log level/), 'debug')
    await fireEvent.click(screen.getByRole('checkbox', { name: /Secure refresh cookies/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save general settings' }))

    expect(await screen.findByText('Application configuration saved')).toBeTruthy()
    expect(savedBody).toEqual({
      api: { host: '0.0.0.0', port: 8080 },
      auth: {
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
        secureCookies: true,
      },
      chat: { defaultAgent: 'support' },
      database: { busyTimeoutMs: 5000, path: 'state/nox.db', synchronous: 'normal' },
      logLevel: 'debug',
    })
  })

  it('validates General numeric limits before writing app.json', async () => {
    let writes = 0
    const app = {
      api: { host: '0.0.0.0', port: 8080 },
      auth: {
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
        secureCookies: false,
      },
      chat: {},
      database: { busyTimeoutMs: 5000, path: 'nox.db', synchronous: 'normal' },
      logLevel: 'info',
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [
            sectionSummary('app', 'file', false, 'app.json', true),
            sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          ],
        }),
      ),
      http.get('*/api/config/app', () =>
        HttpResponse.json({
          ...sectionSummary('app', 'file', false, 'app.json', true),
          value: app,
        }),
      ),
      http.get('*/api/config/blueprints', () =>
        HttpResponse.json({
          ...sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          value: { nox: { model: 'main', provider: 'main', systemPrompt: 'Primary' } },
        }),
      ),
      http.put('*/api/config/app', () => {
        writes += 1
        return HttpResponse.json({
          ...sectionSummary('app', 'file', false, 'app.json', true),
          restartRequired: true,
          value: app,
        })
      }),
    )

    await renderAt('/settings/general')
    await screen.findByRole('heading', { name: 'General' })
    await fireEvent.update(screen.getByLabelText(/^HTTP port/), '70000')
    await fireEvent.update(screen.getByLabelText(/^Access token TTL/), '30')
    await fireEvent.click(screen.getByRole('button', { name: 'Save general settings' }))

    expect(await screen.findByText('Use a whole number from 0 to 65535.')).toBeTruthy()
    expect(screen.getByText('Use a whole number from 60 to 3600.')).toBeTruthy()
    expect(writes).toBe(0)
  })

  it('edits an agent through the curated form without dropping advanced configuration', async () => {
    let savedBody: unknown
    const blueprint = {
      context: { foldMinReductionRatio: 0.25 },
      description: 'Local Nox test agent',
      generation: { seed: 7 },
      maxIterations: 90,
      model: 'qwen38-27b',
      provider: 'main',
      systemPrompt: 'You are Nox.',
      taskModels: { title: { model: 'qwen38-9b' } },
      toolSets: { direct: [], routed: ['internet'] },
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          defaultAgent: 'nox',
          sections: [
            sectionSummary('app', 'file', false, 'app.json', true),
            sectionSummary('blueprints', 'directory', true, 'blueprints', false),
            sectionSummary('providers', 'contribution', true, 'providers.json', true),
            sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
          ],
        }),
      ),
      http.get('*/api/config/blueprints', () =>
        HttpResponse.json({
          ...sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          value: { nox: blueprint },
        }),
      ),
      http.get('*/api/config/providers', () =>
        HttpResponse.json({
          ...sectionSummary('providers', 'contribution', true, 'providers.json', true),
          value: {
            main: {
              baseUrl: 'https://models.example/v1',
              defaultModel: 'qwen38-27b',
              modelConfigs: [{ contextWindow: 131_072, modelId: 'qwen38-27b', type: 'text' }],
              type: 'openai_completions',
            },
          },
        }),
      ),
      http.get('*/api/config/toolSets', () =>
        HttpResponse.json({
          ...sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
          value: { internet: { type: 'web' } },
        }),
      ),
      http.get('*/api/capabilities/tool-sets', () =>
        HttpResponse.json({
          toolSets: [
            {
              available: true,
              description: 'Search and extract public web pages.',
              id: 'internet',
              name: 'Web tools',
              tools: [
                {
                  authority: 'nox.toolset.web.extract',
                  description: 'Extract readable page content.',
                  name: 'web_extract',
                },
                {
                  authority: 'nox.toolset.web.search',
                  description: 'Search the public web.',
                  name: 'web_search',
                },
              ],
              type: 'web',
            },
          ],
        }),
      ),
      http.put('*/api/config/blueprints/nox', async ({ request }) => {
        savedBody = await request.json()
        return HttpResponse.json({
          entryId: 'nox',
          restartRequired: true,
          section: 'blueprints',
          value: savedBody,
        })
      }),
    )

    await renderAt('/settings/agents/nox')

    expect(await screen.findByRole('heading', { name: 'nox' })).toBeTruthy()
    expect(screen.getByLabelText(/^Provider REQ$/)).toHaveProperty('value', 'main')
    expect(screen.getByPlaceholderText('model-id')).toHaveProperty('value', 'qwen38-27b')
    expect(screen.getByPlaceholderText('You are...')).toHaveProperty('value', 'You are Nox.')

    const directPanel = screen.getByRole('heading', { name: 'Direct' }).closest('section')
    const routedPanel = screen.getByRole('heading', { name: 'Routed' }).closest('section')
    if (directPanel === null || routedPanel === null) {
      throw new Error('Expected both tool grant lists.')
    }
    expect(within(directPanel).getByText(/No direct capabilities/)).toBeTruthy()
    expect(within(routedPanel).getByText('internet')).toBeTruthy()

    await fireEvent.update(screen.getByLabelText(/^Description/), 'Primary personal agent')
    await fireEvent.click(within(directPanel).getByRole('button', { name: '+ Add' }))
    await fireEvent.update(screen.getByLabelText('Search configured Tool Sets'), 'internet')
    await fireEvent.click(
      within(directPanel).getByRole('button', { name: /internet.*MOVE FROM ROUTED/i }),
    )
    expect(within(directPanel).getByText('internet')).toBeTruthy()
    expect(within(routedPanel).getByText(/No routed capabilities/)).toBeTruthy()

    await fireEvent.click(within(directPanel).getByRole('button', { name: /Selected tools/ }))
    const extractTool = within(directPanel).getByRole('checkbox', { name: /web_extract/ })
    const searchTool = within(directPanel).getByRole('checkbox', { name: /web_search/ })
    expect(extractTool).toHaveProperty('checked', true)
    expect(searchTool).toHaveProperty('checked', true)
    await fireEvent.click(extractTool)
    await fireEvent.click(screen.getByRole('button', { name: 'Save agent' }))

    expect(await screen.findByText('Agent blueprint saved')).toBeTruthy()
    expect(savedBody).toMatchObject({
      context: { foldMinReductionRatio: 0.25 },
      description: 'Primary personal agent',
      generation: { seed: 7 },
      taskModels: { title: { model: 'qwen38-9b' } },
      toolSets: { direct: [{ id: 'internet', tools: ['web_search'] }], routed: [] },
    })
  })

  it('edits a provider and writes its credential only through the secrets surface', async () => {
    const writes: string[] = []
    let providerBody: unknown
    const provider = {
      apiKey: { $secret: 'LLAMA_API_KEY' },
      baseUrl: 'https://models.example/v1',
      defaultModel: 'qwen38-27b',
      maxRetries: 2,
      maxRetryDelayMs: 30_000,
      modelConfigs: [{ contextWindow: 131_072, modelId: 'qwen38-27b', type: 'text' }],
      retryDelayMs: 500,
      type: 'openai_completions',
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [sectionSummary('providers', 'contribution', true, 'providers.json', true)],
        }),
      ),
      http.get('*/api/config/providers', () =>
        HttpResponse.json({
          ...sectionSummary('providers', 'contribution', true, 'providers.json', true),
          value: { main: provider },
        }),
      ),
      http.get('*/api/secrets', () =>
        HttpResponse.json({
          secrets: [
            {
              consumers: [
                { extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' },
              ],
              createdAt: 10,
              references: [{ location: 'providers.main.apiKey', secretId: 'LLAMA_API_KEY' }],
              restartRequired: true,
              secretId: 'LLAMA_API_KEY',
              stored: true,
              updatedAt: 20,
            },
          ],
        }),
      ),
      http.put('*/api/secrets/LLAMA_API_KEY', async ({ request }) => {
        writes.push('secret')
        expect(await request.json()).toEqual({ value: 'replacement-key' })
        return HttpResponse.json({
          consumers: [{ extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' }],
          createdAt: 10,
          references: [{ location: 'providers.main.apiKey', secretId: 'LLAMA_API_KEY' }],
          restartRequired: true,
          secretId: 'LLAMA_API_KEY',
          stored: true,
          updatedAt: 30,
        })
      }),
      http.put('*/api/config/providers/main', async ({ request }) => {
        writes.push('provider')
        providerBody = await request.json()
        return HttpResponse.json({
          entryId: 'main',
          restartRequired: true,
          section: 'providers',
          value: providerBody,
        })
      }),
    )

    await renderAt('/settings/providers/main')

    expect(await screen.findByRole('heading', { name: 'main' })).toBeTruthy()
    expect(screen.getByPlaceholderText('model-id')).toHaveProperty('value', 'qwen38-27b')
    expect(screen.getByPlaceholderText('131072')).toHaveProperty('value', '131072')
    expect(screen.getByLabelText('API credential')).toHaveProperty('value', 'LLAMA_API_KEY')
    expect(screen.getByText('STORED')).toBeTruthy()

    await fireEvent.update(
      screen.getByPlaceholderText('https://api.example.com/v1'),
      'https://new-models.example/v1',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Replace value' }))
    const secretValue = screen.getByPlaceholderText('Value will not be shown again')
    expect(secretValue).toHaveProperty('type', 'password')
    await fireEvent.update(secretValue, 'replacement-key')
    await fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    // Secrets first: configuration that named a value which does not exist yet
    // would be configuration nothing could compose.
    await waitFor(() => {
      expect(writes).toEqual(['secret', 'provider'])
    })
    expect(await screen.findByText('Provider configuration saved')).toBeTruthy()
    expect(providerBody).toMatchObject({
      apiKey: { $secret: 'LLAMA_API_KEY' },
      baseUrl: 'https://new-models.example/v1',
    })
    expect(JSON.stringify(providerBody)).not.toContain('replacement-key')
  })

  it('creates a provider and its new managed secret as one settings operation', async () => {
    const writes: string[] = []
    let providerBody: unknown

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [sectionSummary('providers', 'contribution', true, 'providers.json', true)],
        }),
      ),
      http.get('*/api/config/providers', () =>
        HttpResponse.json({
          ...sectionSummary('providers', 'contribution', true, 'providers.json', true),
          value: {},
        }),
      ),
      http.get('*/api/secrets', () => HttpResponse.json({ secrets: [] })),
      http.put('*/api/secrets/SECONDARY_API_KEY', async ({ request }) => {
        writes.push('secret')
        expect(await request.json()).toEqual({ value: 'secondary-key' })
        return HttpResponse.json({
          consumers: [],
          createdAt: 10,
          references: [],
          restartRequired: false,
          secretId: 'SECONDARY_API_KEY',
          stored: true,
          updatedAt: 10,
        })
      }),
      http.post('*/api/config/providers/secondary', async ({ request }) => {
        writes.push('provider')
        providerBody = await request.json()
        return HttpResponse.json({
          entryId: 'secondary',
          restartRequired: true,
          section: 'providers',
          value: providerBody,
        })
      }),
    )

    await renderAt('/settings/providers?create=1')

    expect(await screen.findByRole('heading', { name: 'New provider' })).toBeTruthy()
    await fireEvent.update(screen.getByPlaceholderText('main'), 'secondary')
    await fireEvent.update(
      screen.getByPlaceholderText('https://api.example.com/v1'),
      'https://secondary.example/v1',
    )
    await fireEvent.update(screen.getByLabelText('API credential'), '__new_secret__')
    await fireEvent.update(screen.getByPlaceholderText('OPENAI_API_KEY'), 'SECONDARY_API_KEY')
    await fireEvent.update(
      screen.getByPlaceholderText('Value will not be shown again'),
      'secondary-key',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    await waitFor(() => {
      expect(writes).toEqual(['secret', 'provider'])
    })
    expect(providerBody).toMatchObject({
      apiKey: { $secret: 'SECONDARY_API_KEY' },
      baseUrl: 'https://secondary.example/v1',
      type: 'openai_completions',
    })
    await waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/settings/providers/secondary')
    })
  })

  it('groups extension-owned capabilities without offering manual creation', async () => {
    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [
            sectionSummary('blueprints', 'directory', true, 'blueprints', false),
            sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
            sectionSummary('brokers', 'contribution', true, 'brokers.json', true),
          ],
        }),
      ),
      http.get('*/api/config/blueprints', () =>
        HttpResponse.json({
          ...sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          value: {},
        }),
      ),
      http.get('*/api/config/toolSets', () =>
        HttpResponse.json({
          ...sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
          value: {},
        }),
      ),
      http.get('*/api/config/brokers', () =>
        HttpResponse.json({
          ...sectionSummary('brokers', 'contribution', true, 'brokers.json', true),
          value: {},
        }),
      ),
      http.get('*/api/secrets', () => HttpResponse.json({ secrets: [] })),
    )

    await renderAt('/settings/tool-sets?create=1')

    expect(await screen.findByRole('heading', { name: 'Tool Sets' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'New tool set' })).toBeNull()
    expect(screen.queryByRole('link', { name: /New tool set/ })).toBeNull()
    expect(screen.getByText(/no active extension has contributed an entry/)).toBeTruthy()

    const capabilitiesHeading = screen.getByRole('heading', { name: 'CAPABILITIES' })
    const capabilitiesGroup = capabilitiesHeading.closest('section')
    if (capabilitiesGroup === null) throw new Error('Expected the capabilities navigation group.')
    expect(within(capabilitiesGroup).getByRole('link', { name: 'Tool Sets' })).toBeTruthy()
    expect(within(capabilitiesGroup).getByRole('link', { name: 'Brokers' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'CONNECTIONS' })).toBeNull()

    await fireEvent.click(within(capabilitiesGroup).getByRole('link', { name: 'Brokers' }))

    expect(await screen.findByRole('heading', { name: 'Brokers' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'New broker' })).toBeNull()
    expect(screen.queryByRole('link', { name: /New broker/ })).toBeNull()
  })

  it('edits web tools, preserves contributed fields and writes endpoint secrets separately', async () => {
    const writes: string[] = []
    let toolSetBody: unknown
    const toolSet = {
      extract: {
        customResponseMode: 'markdown',
        defaultMaxCharactersPerPage: 30_000,
        maxCharactersPerPage: 100_000,
        maxUrls: 5,
        url: 'https://crawl.example',
      },
      search: {
        apiKey: { $secret: 'SEARCH_API_KEY' },
        defaultLanguage: 'all',
        defaultMaxResults: 8,
        maxResults: 20,
        url: 'https://search.example',
      },
      type: 'web',
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true)],
        }),
      ),
      http.get('*/api/config/toolSets', () =>
        HttpResponse.json({
          ...sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
          value: { internet: toolSet },
        }),
      ),
      http.get('*/api/secrets', () =>
        HttpResponse.json({
          secrets: [
            {
              consumers: [
                { extensionId: 'nox.toolset.web', location: 'toolSets.internet.search.apiKey' },
              ],
              createdAt: 10,
              references: [
                { location: 'toolSets.internet.search.apiKey', secretId: 'SEARCH_API_KEY' },
              ],
              restartRequired: true,
              secretId: 'SEARCH_API_KEY',
              stored: true,
              updatedAt: 20,
            },
          ],
        }),
      ),
      http.put('*/api/secrets/SEARCH_API_KEY', async ({ request }) => {
        writes.push('search-secret')
        expect(await request.json()).toEqual({ value: 'search-key-v2' })
        return HttpResponse.json({
          consumers: [],
          createdAt: 10,
          references: [],
          restartRequired: true,
          secretId: 'SEARCH_API_KEY',
          stored: true,
          updatedAt: 30,
        })
      }),
      http.put('*/api/secrets/EXTRACT_API_KEY', async ({ request }) => {
        writes.push('extract-secret')
        expect(await request.json()).toEqual({ value: 'extract-key' })
        return HttpResponse.json({
          consumers: [],
          createdAt: 40,
          references: [],
          restartRequired: false,
          secretId: 'EXTRACT_API_KEY',
          stored: true,
          updatedAt: 40,
        })
      }),
      http.put('*/api/config/toolSets/internet', async ({ request }) => {
        writes.push('tool-set')
        toolSetBody = await request.json()
        return HttpResponse.json({
          entryId: 'internet',
          restartRequired: true,
          section: 'toolSets',
          value: toolSetBody,
        })
      }),
    )

    await renderAt('/settings/tool-sets/internet')

    expect(await screen.findByRole('heading', { name: 'internet' })).toBeTruthy()
    expect(screen.getByPlaceholderText('https://search.example')).toHaveProperty(
      'value',
      'https://search.example',
    )
    expect(screen.getByPlaceholderText('https://crawl.example')).toHaveProperty(
      'value',
      'https://crawl.example',
    )
    expect(screen.getByLabelText('Search credential')).toHaveProperty('value', 'SEARCH_API_KEY')
    expect(screen.getByRole('checkbox', { name: /web_extract/ })).toHaveProperty('checked', true)

    await fireEvent.update(screen.getByLabelText(/^Default results/), '10')
    await fireEvent.update(screen.getByPlaceholderText('Search credential value'), 'search-key-v2')
    await fireEvent.update(screen.getByLabelText('Extraction credential'), '__new_secret__')
    await fireEvent.update(screen.getByPlaceholderText('CRAWL4AI_API_KEY'), 'EXTRACT_API_KEY')
    await fireEvent.update(
      screen.getByPlaceholderText('Extraction credential value'),
      'extract-key',
    )
    await fireEvent.click(screen.getByRole('checkbox', { name: /web_extract/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save tool set' }))

    await waitFor(() => {
      expect(writes).toEqual(['search-secret', 'extract-secret', 'tool-set'])
    })
    expect(await screen.findByText('Tool-set configuration saved')).toBeTruthy()
    expect(toolSetBody).toMatchObject({
      enabledTools: ['web_search'],
      // Each endpoint carries its own ID, and contributed fields the curated
      // form never rendered survive the round trip.
      extract: {
        apiKey: { $secret: 'EXTRACT_API_KEY' },
        customResponseMode: 'markdown',
      },
      search: {
        apiKey: { $secret: 'SEARCH_API_KEY' },
        defaultMaxResults: 10,
      },
      type: 'web',
    })
    expect(JSON.stringify(toolSetBody)).not.toContain('search-key-v2')
    expect(JSON.stringify(toolSetBody)).not.toContain('extract-key')
  })

  it('keeps contributed tool-set types on the full-fidelity JSON surface', async () => {
    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true)],
        }),
      ),
      http.get('*/api/config/toolSets', () =>
        HttpResponse.json({
          ...sectionSummary('toolSets', 'contribution', true, 'toolsets.json', true),
          value: { files: { root: '/srv/shared', type: 'filesystem' } },
        }),
      ),
      http.get('*/api/secrets', () => HttpResponse.json({ secrets: [] })),
    )

    await renderAt('/settings/tool-sets/files')

    expect(await screen.findByRole('heading', { name: 'files' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'JSON' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('JSON object')).toHaveProperty(
      'value',
      '{\n  "root": "/srv/shared",\n  "type": "filesystem"\n}',
    )
    expect(screen.queryByPlaceholderText('https://search.example')).toBeNull()
  })

  it('edits broker routing and grants while keeping contributed credentials write-only', async () => {
    const writes: string[] = []
    let brokerBody: unknown
    const broker = {
      agent: 'nox',
      conversations: {
        team: {
          agent: 'support',
          grants: { bob: ['nox.toolset.web.*'] },
        },
      },
      enabled: true,
      gatewayUrl: 'wss://gateway.example',
      grants: { alice: ['nox.history.read'] },
      intents: ['messages'],
      token: { $secret: 'DISCORD_TOKEN' },
      type: 'discord',
    }

    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          sections: [
            sectionSummary('blueprints', 'directory', true, 'blueprints', false),
            sectionSummary('brokers', 'contribution', true, 'brokers.json', true),
          ],
        }),
      ),
      http.get('*/api/config/brokers', () =>
        HttpResponse.json({
          ...sectionSummary('brokers', 'contribution', true, 'brokers.json', true),
          value: { relay: broker },
        }),
      ),
      http.get('*/api/config/blueprints', () =>
        HttpResponse.json({
          ...sectionSummary('blueprints', 'directory', true, 'blueprints', false),
          value: {
            nox: { model: 'main', provider: 'main', systemPrompt: 'Primary' },
            support: { model: 'main', provider: 'main', systemPrompt: 'Support' },
          },
        }),
      ),
      http.get('*/api/secrets', () =>
        HttpResponse.json({
          secrets: [
            {
              consumers: [{ extensionId: 'test.discord', location: 'brokers.relay.token' }],
              createdAt: 10,
              references: [{ location: 'brokers.relay.token', secretId: 'DISCORD_TOKEN' }],
              restartRequired: true,
              secretId: 'DISCORD_TOKEN',
              stored: true,
              updatedAt: 20,
            },
          ],
        }),
      ),
      http.put('*/api/secrets/DISCORD_TOKEN', async ({ request }) => {
        writes.push('secret')
        expect(await request.json()).toEqual({ value: 'discord-token-v2' })
        return HttpResponse.json({
          consumers: [],
          createdAt: 10,
          references: [{ location: 'brokers.relay.token', secretId: 'DISCORD_TOKEN' }],
          restartRequired: true,
          secretId: 'DISCORD_TOKEN',
          stored: true,
          updatedAt: 30,
        })
      }),
      http.put('*/api/config/brokers/relay', async ({ request }) => {
        writes.push('broker')
        brokerBody = await request.json()
        return HttpResponse.json({
          entryId: 'relay',
          restartRequired: true,
          section: 'brokers',
          value: brokerBody,
        })
      }),
    )

    await renderAt('/settings/brokers/relay')

    expect(await screen.findByRole('heading', { name: 'relay' })).toBeTruthy()
    expect(screen.getByLabelText(/^Base agent/)).toHaveProperty('value', 'nox')
    expect(screen.getByText('STORED')).toBeTruthy()
    expect(screen.getByLabelText('Contribution JSON')).toHaveProperty(
      'value',
      '{\n  "gatewayUrl": "wss://gateway.example",\n  "intents": [\n    "messages"\n  ],\n  "token": {\n    "$secret": "DISCORD_TOKEN"\n  }\n}',
    )

    await fireEvent.update(screen.getByLabelText(/^Base agent/), 'support')
    const [basePattern] = screen.getAllByPlaceholderText('nox.history.read')
    if (basePattern === undefined) throw new Error('Expected the base grant pattern field.')
    expect(basePattern).toHaveProperty('value', 'nox.history.read')
    await fireEvent.update(basePattern, 'nox.history.search')
    await fireEvent.update(
      screen.getByPlaceholderText('New value for DISCORD_TOKEN'),
      'discord-token-v2',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Save broker' }))

    await waitFor(() => {
      expect(writes).toEqual(['secret', 'broker'])
    })
    expect(await screen.findByText('Broker configuration saved')).toBeTruthy()
    expect(brokerBody).toMatchObject({
      agent: 'support',
      conversations: {
        team: { agent: 'support', grants: { bob: ['nox.toolset.web.*'] } },
      },
      gatewayUrl: 'wss://gateway.example',
      grants: { alice: ['nox.history.search'] },
      intents: ['messages'],
      token: { $secret: 'DISCORD_TOKEN' },
      type: 'discord',
    })
    expect(JSON.stringify(brokerBody)).not.toContain('discord-token-v2')
  })

  it('restores a deep-linked write-only secret without exposing its value', async () => {
    server.use(
      ...authenticatedOperator(),
      http.get('*/api/config', () =>
        HttpResponse.json({
          defaultAgent: 'nox',
          sections: [
            {
              applies: 'restart',
              entries: false,
              key: 'app',
              kind: 'file',
              loaded: true,
              name: 'app.json',
              writable: true,
            },
          ],
        }),
      ),
      http.get('*/api/secrets', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer access-token')
        return HttpResponse.json({
          secrets: [
            {
              consumers: [
                { extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' },
              ],
              createdAt: 10,
              references: [],
              restartRequired: true,
              secretId: 'OPENAI_API_KEY',
              stored: true,
              updatedAt: 20,
            },
          ],
        })
      }),
    )

    await renderAt('/settings/secrets/OPENAI_API_KEY')

    expect(await screen.findByRole('heading', { name: 'OPENAI_API_KEY' })).toBeTruthy()
    expect(router.currentRoute.value.fullPath).toBe('/settings/secrets/OPENAI_API_KEY')
    expect(screen.getByText('providers.main.apiKey')).toBeTruthy()

    const value = screen.getByLabelText(/^New value/)
    expect(value).toHaveProperty('type', 'password')
    expect(value).toHaveProperty('value', '')
  })
})

function authenticatedOperator() {
  return [
    http.get('*/api/auth/status', () => HttpResponse.json({ registered: true })),
    http.post('*/api/auth/refresh', () =>
      HttpResponse.json({ accessToken: 'access-token', expiresInSeconds: 900 }),
    ),
    http.get('*/api/auth/me', () =>
      HttpResponse.json({
        account: { accountId: 'operator-1', createdAt: 1, username: 'operator' },
      }),
    ),
  ] as const
}

function sectionSummary(
  key: string,
  kind: 'contribution' | 'directory' | 'file',
  entries: boolean,
  name: string,
  writable: boolean,
) {
  return { applies: 'restart', entries, key, kind, loaded: true, name, writable }
}

async function renderAt(path: string): Promise<void> {
  await router.push(path)
  await router.isReady()
  render(App, { global: { plugins: [createPinia(), router] } })
}
