import { type App, type Plugin, readonly, type Ref, ref, shallowRef } from 'vue'

import {
  i18nApi,
  type LanguageCatalog,
  type LanguageDescriptor,
  type LanguagePack,
} from './i18n.api'

type MessageParameters = Readonly<Record<string, boolean | number | string>>

interface I18nContext {
  readonly availableLanguages: Readonly<Ref<readonly LanguageDescriptor[]>>
  readonly formatDate: typeof formatDate
  readonly formatNumber: typeof formatNumber
  readonly hasMessage: typeof hasMessage
  readonly locale: Readonly<Ref<string>>
  readonly plural: typeof plural
  readonly setLocale: typeof setLocale
  readonly t: typeof t
}

const STORAGE_KEY = 'nox.locale'
const availableLanguages = ref<readonly LanguageDescriptor[]>([])
const locale = ref('')
const selectedMessages = shallowRef<Readonly<Record<string, string>>>({})
const fallbackMessages = shallowRef<Readonly<Record<string, string>>>({})
const defaultLocale = ref('')
const loadedPacks = new Map<string, LanguagePack>()
let initialization: Promise<void> | undefined
let localeVersion = 0

function interpolate(message: string, parameters: MessageParameters): string {
  return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (placeholder, name: string) => {
    const value = parameters[name]
    return value === undefined ? placeholder : String(value)
  })
}

function t(key: string, parameters: MessageParameters = {}): string {
  const message = selectedMessages.value[key] ?? fallbackMessages.value[key] ?? key
  return interpolate(message, parameters)
}

function plural(key: string, count: number, parameters: MessageParameters = {}): string {
  const currentLocale = locale.value.length === 0 ? undefined : locale.value
  const category = new Intl.PluralRules(currentLocale).select(count)
  const categoryKey = `${key}.${category}`
  const otherKey = `${key}.other`
  const resolved = hasMessage(categoryKey) ? categoryKey : otherKey
  return t(resolved, { ...parameters, count })
}

function hasMessage(key: string): boolean {
  return key in selectedMessages.value || key in fallbackMessages.value
}

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  const currentLocale = locale.value.length === 0 ? undefined : locale.value
  return new Intl.NumberFormat(currentLocale, options).format(value)
}

function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const currentLocale = locale.value.length === 0 ? undefined : locale.value
  return new Intl.DateTimeFormat(currentLocale, options).format(
    value instanceof Date ? value : new Date(value),
  )
}

function initialize(): Promise<void> {
  initialization ??= initializeFromApi().catch((error: unknown) => {
    initialization = undefined
    throw error
  })
  return initialization
}

async function initializeFromApi(): Promise<void> {
  const catalog = await i18nApi.catalog()
  availableLanguages.value = Object.freeze([...catalog.languages])
  defaultLocale.value = catalog.defaultLocale
  const requested = preferredLocales(catalog.configuredLocale)
  await setLocale(matchLocale(requested, catalog) ?? catalog.defaultLocale)
}

async function loadPack(nextLocale: string): Promise<LanguagePack> {
  const cached = loadedPacks.get(nextLocale)
  if (cached !== undefined) return cached
  const pack = await i18nApi.pack(nextLocale)
  loadedPacks.set(nextLocale, pack)
  return pack
}

async function setLocale(nextLocale: string): Promise<void> {
  const descriptor = availableLanguages.value.find((language) => language.locale === nextLocale)
  if (descriptor === undefined) return

  const version = ++localeVersion
  const [selected, fallback] = await Promise.all([
    loadPack(nextLocale),
    nextLocale === defaultLocale.value ? loadPack(nextLocale) : loadPack(defaultLocale.value),
  ])
  if (version !== localeVersion) return
  selectedMessages.value = Object.freeze({ ...selected.messages })
  fallbackMessages.value = Object.freeze({ ...fallback.messages })
  locale.value = selected.locale
  persistLocale(selected.locale)
  applyDocumentLanguage(selected)
}

function preferredLocales(configuredLocale?: string): readonly string[] {
  const persisted = readPersistedLocale()
  const browser = typeof navigator === 'undefined' ? [] : navigator.languages
  return [
    ...(persisted === undefined ? [] : [persisted]),
    ...(configuredLocale === undefined ? [] : [configuredLocale]),
    ...browser,
  ]
}

function matchLocale(requested: readonly string[], catalog: LanguageCatalog): string | undefined {
  const available = new Set(catalog.languages.map((language) => language.locale))
  for (const candidate of requested) {
    const subtags = candidate.toLowerCase().split('-')
    while (subtags.length > 0) {
      const normalized = subtags.join('-')
      if (available.has(normalized)) return normalized
      subtags.pop()
    }
  }
  return undefined
}

function readPersistedLocale(): string | undefined {
  try {
    return typeof localStorage === 'undefined'
      ? undefined
      : (localStorage.getItem(STORAGE_KEY) ?? undefined)
  } catch {
    return undefined
  }
}

function persistLocale(nextLocale: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, nextLocale)
  } catch {
    // A blocked storage surface makes the choice session-only, not unusable.
  }
}

function applyDocumentLanguage(pack: LanguagePack): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = pack.locale
  document.documentElement.dir = pack.direction
}

/** Unit tests install copy without reaching across the HTTP boundary into a builtin package. */
function installTestLanguage(
  messages: Readonly<Record<string, string>>,
  testLocale = 'en',
  additionalLocales: readonly string[] = [],
): void {
  localeVersion += 1
  const locales = [testLocale, ...additionalLocales]
  const packs = locales.map<LanguagePack>((candidate) => ({
    direction: 'ltr',
    locale: candidate,
    messages,
    name: candidate === testLocale ? 'Test language' : `Test language (${candidate})`,
  }))
  const pack = packs[0]
  if (pack === undefined) throw new Error('A test language is required.')
  loadedPacks.clear()
  for (const candidate of packs) loadedPacks.set(candidate.locale, candidate)
  availableLanguages.value = packs.map(({ direction, locale: candidate, name }) => ({
    direction,
    locale: candidate,
    name,
  }))
  defaultLocale.value = testLocale
  locale.value = testLocale
  selectedMessages.value = messages
  fallbackMessages.value = messages
  initialization = Promise.resolve()
  applyDocumentLanguage(pack)
}

const i18n: Plugin & {
  readonly initialize: typeof initialize
  readonly setLocale: typeof setLocale
} = Object.freeze({
  initialize,
  install(app: App) {
    app.config.globalProperties.$t = t
    app.config.globalProperties.$plural = plural
  },
  setLocale,
})

function useI18n(): I18nContext {
  return {
    availableLanguages: readonly(availableLanguages),
    formatDate,
    formatNumber,
    hasMessage,
    locale: readonly(locale),
    plural,
    setLocale,
    t,
  }
}

export { i18n, installTestLanguage, useI18n }

export type { MessageParameters }
