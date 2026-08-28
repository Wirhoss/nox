import type { SectionSummary } from '../api/settings.api'

interface SettingsCatalog {
  readonly sections: readonly SectionSummary[]
}

type SettingsGroup = 'security' | SectionSummary['group']
type SettingsEditor = 'secrets' | SectionSummary['editor']

interface SettingsSectionDefinition {
  readonly creatable: boolean
  readonly description: string
  readonly editor: SettingsEditor
  readonly group: SettingsGroup
  readonly key?: string
  readonly label: string
  readonly plural: string
  readonly slug: string
}

/** Secrets are a separate control-plane resource, not a duplicated config section. */
const SECRETS_SECTION = Object.freeze({
  creatable: true,
  description: 'settings.sections.secrets.description',
  editor: 'secrets',
  group: 'security',
  label: 'settings.sections.secrets.label',
  plural: 'settings.sections.secrets.plural',
  slug: 'secrets',
} as const satisfies SettingsSectionDefinition)

const SETTINGS_GROUPS: readonly SettingsGroup[] = Object.freeze([
  'machine',
  'intelligence',
  'capabilities',
  'security',
])

/** The runtime catalog is the only table of configurable sections. */
function settingsSections(catalog: SettingsCatalog | undefined): readonly SettingsSectionDefinition[] {
  return [...(catalog?.sections ?? []), SECRETS_SECTION]
}

function settingsSection(
  catalog: SettingsCatalog | undefined,
  slug: string,
): SettingsSectionDefinition | undefined {
  return settingsSections(catalog).find((section) => section.slug === slug)
}

function settingsSlug(catalog: SettingsCatalog | undefined, key: string): string | undefined {
  return catalog?.sections.find((section) => section.key === key)?.slug
}

export { SECRETS_SECTION, SETTINGS_GROUPS, settingsSection, settingsSections, settingsSlug }

export type { SettingsCatalog, SettingsEditor, SettingsGroup, SettingsSectionDefinition }
