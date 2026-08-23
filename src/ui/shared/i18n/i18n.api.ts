import { z } from 'zod'

import { requestJson } from '@/shared/api/http'

const languageDescriptorSchema = z.object({
  direction: z.enum(['ltr', 'rtl']),
  locale: z.string().min(2),
  name: z.string().min(1),
})
const languageCatalogSchema = z.object({
  configuredLocale: z.string().min(2).optional(),
  defaultLocale: z.string().min(2),
  languages: z.array(languageDescriptorSchema),
})
const languagePackSchema = languageDescriptorSchema.extend({
  messages: z.record(z.string(), z.string()),
})

type LanguageCatalog = z.infer<typeof languageCatalogSchema>
type LanguageDescriptor = z.infer<typeof languageDescriptorSchema>
type LanguagePack = z.infer<typeof languagePackSchema>

const i18nApi = {
  catalog(): Promise<LanguageCatalog> {
    return requestJson('/i18n/languages', languageCatalogSchema)
  },
  pack(locale: string): Promise<LanguagePack> {
    return requestJson(`/i18n/languages/${encodeURIComponent(locale)}`, languagePackSchema)
  },
}

export { i18nApi }

export type { LanguageCatalog, LanguageDescriptor, LanguagePack }
