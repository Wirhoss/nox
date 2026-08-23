interface SettingsSectionDefinition {
  readonly creatable: boolean
  readonly description: string
  readonly group: 'CAPABILITIES' | 'INTELLIGENCE' | 'MACHINE' | 'SECURITY'
  readonly key?: string
  readonly label: string
  readonly plural: string
  readonly slug: string
}

const SETTINGS_SECTIONS = Object.freeze([
  {
    creatable: false,
    description: 'Runtime, access, storage and logging defaults.',
    group: 'MACHINE',
    key: 'app',
    label: 'General',
    plural: 'General',
    slug: 'general',
  },
  {
    creatable: true,
    description: 'Agent identities, models, capabilities and gate policy.',
    group: 'INTELLIGENCE',
    key: 'blueprints',
    label: 'Agent',
    plural: 'Agents',
    slug: 'agents',
  },
  {
    creatable: true,
    description: 'Model endpoints and the models available through them.',
    group: 'INTELLIGENCE',
    key: 'providers',
    label: 'Provider',
    plural: 'Providers',
    slug: 'providers',
  },
  {
    creatable: false,
    description: 'Capability bundles contributed by extensions and granted to Agents.',
    group: 'CAPABILITIES',
    key: 'toolSets',
    label: 'Tool set',
    plural: 'Tool Sets',
    slug: 'tool-sets',
  },
  {
    creatable: false,
    description: 'Conversation transports contributed by extensions.',
    group: 'CAPABILITIES',
    key: 'brokers',
    label: 'Broker',
    plural: 'Brokers',
    slug: 'brokers',
  },
  {
    creatable: true,
    description: 'Write-only credentials used by providers and extensions.',
    group: 'SECURITY',
    label: 'Secret',
    plural: 'Secrets',
    slug: 'secrets',
  },
] as const satisfies readonly SettingsSectionDefinition[])

const SETTINGS_GROUPS: readonly SettingsSectionDefinition['group'][] = Object.freeze([
  'MACHINE',
  'INTELLIGENCE',
  'CAPABILITIES',
  'SECURITY',
])

function settingsSection(slug: string): SettingsSectionDefinition | undefined {
  return SETTINGS_SECTIONS.find((section) => section.slug === slug)
}

function settingsSlug(key: string): string | undefined {
  return SETTINGS_SECTIONS.find((section) => 'key' in section && section.key === key)?.slug
}

export { SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsSection, settingsSlug }

export type { SettingsSectionDefinition }
