import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/tests/server'

const packs = {
  ar: {
    direction: 'rtl',
    locale: 'ar',
    messages: { greeting: 'مرحبًا، {name}' },
    name: 'العربية',
  },
  en: {
    direction: 'ltr',
    locale: 'en',
    messages: {
      fallbackOnly: 'English fallback',
      greeting: 'Hello, {name}',
      'items.one': '{count} item',
      'items.other': '{count} items',
    },
    name: 'English',
  },
  es: {
    direction: 'ltr',
    locale: 'es',
    messages: {
      greeting: 'Hola, {name}',
      'items.one': '{count} elemento',
      'items.other': '{count} elementos',
    },
    name: 'Español',
  },
} as const

describe('i18n runtime', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('uses the configured installation language before the browser default', async () => {
    server.use(
      http.get('*/api/i18n/languages', () =>
        HttpResponse.json({
          configuredLocale: 'es',
          defaultLocale: 'en',
          languages: [
            { direction: 'ltr', locale: 'en', name: 'English' },
            { direction: 'ltr', locale: 'es', name: 'Español' },
          ],
        }),
      ),
      http.get('*/api/i18n/languages/:locale', ({ params }) => {
        if (params.locale !== 'en' && params.locale !== 'es') {
          return HttpResponse.json({ error: 'language_not_found' }, { status: 404 })
        }
        return HttpResponse.json(packs[params.locale])
      }),
    )

    const { i18n, useI18n } = await import('./i18n')
    await i18n.initialize()

    expect(useI18n().locale.value).toBe('es')
  })

  it('loads the preferred extension language and falls back key by key', async () => {
    localStorage.setItem('nox.locale', 'es-MX')
    server.use(
      http.get('*/api/i18n/languages', () =>
        HttpResponse.json({
          configuredLocale: 'en',
          defaultLocale: 'en',
          languages: [
            { direction: 'rtl', locale: 'ar', name: 'العربية' },
            { direction: 'ltr', locale: 'en', name: 'English' },
            { direction: 'ltr', locale: 'es', name: 'Español' },
          ],
        }),
      ),
      http.get('*/api/i18n/languages/:locale', ({ params }) => {
        if (params.locale !== 'ar' && params.locale !== 'en' && params.locale !== 'es') {
          return HttpResponse.json({ error: 'language_not_found' }, { status: 404 })
        }
        return HttpResponse.json(packs[params.locale])
      }),
    )

    const { i18n, useI18n } = await import('./i18n')
    await i18n.initialize()
    const runtime = useI18n()

    expect(runtime.locale.value).toBe('es')
    expect(runtime.t('greeting', { name: 'Nox' })).toBe('Hola, Nox')
    expect(runtime.t('fallbackOnly')).toBe('English fallback')
    expect(runtime.t('unknown.key')).toBe('unknown.key')
    expect(runtime.plural('items', 1)).toBe('1 elemento')
    expect(runtime.plural('items', 3)).toBe('3 elementos')
    expect(document.documentElement.lang).toBe('es')
    expect(document.documentElement.dir).toBe('ltr')
    expect(localStorage.getItem('nox.locale')).toBe('es')

    await runtime.setLocale('ar')
    expect(runtime.t('greeting', { name: 'Nox' })).toBe('مرحبًا، Nox')
    expect(runtime.t('fallbackOnly')).toBe('English fallback')
    expect(document.documentElement.lang).toBe('ar')
    expect(document.documentElement.dir).toBe('rtl')
  })
})
