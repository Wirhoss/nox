interface SettingsSectionDefinition {
  readonly creatable: boolean
  readonly description: string
  readonly group: 'capabilities' | 'intelligence' | 'machine' | 'security'
  readonly key?: string
  readonly label: string
  readonly plural: string
  readonly slug: string
}

const SETTINGS_SECTIONS = Object.freeze([
  {
    creatable: false,
    description: 'settings.sections.general.description',
    group: 'machine',
    key: 'app',
    label: 'settings.sections.general.label',
    plural: 'settings.sections.general.plural',
    slug: 'general',
  },
  {
    creatable: true,
    description: 'settings.sections.agents.description',
    group: 'intelligence',
    key: 'blueprints',
    label: 'settings.sections.agents.label',
    plural: 'settings.sections.agents.plural',
    slug: 'agents',
  },
  {
    creatable: true,
    description: 'settings.sections.providers.description',
    group: 'intelligence',
    key: 'providers',
    label: 'settings.sections.providers.label',
    plural: 'settings.sections.providers.plural',
    slug: 'providers',
  },
  {
    creatable: false,
    description: 'settings.sections.toolSets.description',
    group: 'capabilities',
    key: 'toolSets',
    label: 'settings.sections.toolSets.label',
    plural: 'settings.sections.toolSets.plural',
    slug: 'tool-sets',
  },
  {
    creatable: false,
    description: 'settings.sections.brokers.description',
    group: 'capabilities',
    key: 'brokers',
    label: 'settings.sections.brokers.label',
    plural: 'settings.sections.brokers.plural',
    slug: 'brokers',
  },
  {
    creatable: true,
    description: 'settings.sections.secrets.description',
    group: 'security',
    label: 'settings.sections.secrets.label',
    plural: 'settings.sections.secrets.plural',
    slug: 'secrets',
  },
] as const satisfies readonly SettingsSectionDefinition[])

const SETTINGS_GROUPS: readonly SettingsSectionDefinition['group'][] = Object.freeze([
  'machine',
  'intelligence',
  'capabilities',
  'security',
])

function settingsSection(slug: string): SettingsSectionDefinition | undefined {
  return SETTINGS_SECTIONS.find((section) => section.slug === slug)
}

function settingsSlug(key: string): string | undefined {
  return SETTINGS_SECTIONS.find((section) => 'key' in section && section.key === key)?.slug
}

export { SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsSection, settingsSlug }

export type { SettingsSectionDefinition }
