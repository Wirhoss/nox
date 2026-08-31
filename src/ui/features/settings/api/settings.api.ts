import { z } from 'zod'

import { requestJson } from '@/shared/api/http'

const configValueSchema = z.record(z.string(), z.unknown())

/**
 * One contribution a section can hold, and whether it is configured. It travels
 * with the section so a list can show what is installed and not set up yet: an
 * extension with no entry is something to fill in, not an absence.
 */
const contributionSummarySchema = z.object({
  configured: z.boolean(),
  extensionId: z.string().min(1),
  instances: z.enum(['many', 'single']),
  type: z.string().min(1),
})

const entrySummaryDescriptorSchema = z.object({
  description: z.array(z.string().min(1)).readonly(),
  detail: z.array(z.string().min(1)).readonly(),
})

const sectionSummarySchema = z.object({
  applies: z.enum(['hot', 'restart']),
  contributions: z.array(contributionSummarySchema.readonly()).readonly().optional(),
  creatable: z.boolean(),
  description: z.string().min(1),
  editor: z.enum(['app', 'blueprint', 'broker', 'contribution', 'json', 'toolSet']),
  entries: z.boolean(),
  entrySummary: entrySummaryDescriptorSchema.readonly().optional(),
  error: z.string().optional(),
  group: z.enum(['capabilities', 'intelligence', 'machine']),
  inventory: z.array(z.enum(['providers', 'toolSets'])).readonly().optional(),
  key: z.string().min(1),
  kind: z.enum(['contribution', 'directory', 'file']),
  label: z.string().min(1),
  loaded: z.boolean(),
  name: z.string().min(1),
  plural: z.string().min(1),
  references: z.array(z.string().min(1)).readonly(),
  slug: z.string().min(1),
  writable: z.boolean(),
})

const runtimeComponentSchema = z.object({
  activeGeneration: z.number().int().positive().optional(),
  desiredGeneration: z.number().int().positive(),
  error: z.string().optional(),
  id: z.string().min(1),
  kind: z.enum(['agent', 'application', 'broker', 'memory', 'provider', 'toolSet']),
  state: z.enum(['active', 'applying', 'failed', 'restartRequired', 'unavailable']),
})

const runtimeComponentsSchema = z.preprocess(
  (value) => value ?? [],
  z.array(runtimeComponentSchema),
)
const revertAvailableSchema = z.preprocess((value) => value ?? false, z.boolean())

const authoritySummarySchema = z.object({
  description: z.string().min(1),
  id: z.string().min(1),
  ownerExtensionId: z.string().min(1),
})

const configCatalogSchema = z.object({
  authorities: z.preprocess(
    (value) => value ?? [],
    z.array(authoritySummarySchema.readonly()).readonly(),
  ),
  revertAvailable: revertAvailableSchema,
  runtime: runtimeComponentsSchema,
  sections: z.array(sectionSummarySchema),
})

const runtimeStatusSchema = z.object({
  components: z.array(runtimeComponentSchema),
  revertAvailable: revertAvailableSchema,
})

const configSectionSchema = sectionSummarySchema.extend({ value: configValueSchema })

const configEntrySchema = z.object({
  entryId: z.string().min(1),
  section: z.string().min(1),
  value: configValueSchema,
})

const toolInventorySchema = z.object({
  authority: z.string().min(1),
  description: z.string(),
  name: z.string().min(1),
})
const toolSetInventorySchema = z.object({
  available: z.boolean(),
  description: z.string().optional(),
  extensionId: z.string().min(1).optional(),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  problem: z.string().optional(),
  tools: z.array(toolInventorySchema),
  type: z.string(),
})
const toolSetInventoriesSchema = z.object({ toolSets: z.array(toolSetInventorySchema) })

/**
 * One model an operator may choose, and where the choice came from. A declared
 * model carries the metadata the installation depends on; a reported one is a
 * name the endpoint confirmed exists. The editor offers both and says which.
 */
const providerModelInventorySchema = z.object({
  configured: z.boolean(),
  dimensions: z.number().int().positive().optional(),
  kind: z.enum(['chat', 'embedding']).optional(),
  modelId: z.string().min(1),
})
const providerInventorySchema = z.object({
  available: z.boolean(),
  extensionId: z.string().min(1).optional(),
  id: z.string().min(1),
  kinds: z.array(z.enum(['chat', 'embedding'])).readonly(),
  models: z.array(providerModelInventorySchema.readonly()).readonly(),
  problem: z.string().optional(),
  /** Whether the instance itself answered with a list, rather than an empty one. */
  reported: z.boolean(),
  reportProblem: z.string().optional(),
  type: z.string(),
})
const providerInventoriesSchema = z.object({ providers: z.array(providerInventorySchema) })

/**
 * One configurable kind and the schema its entries must satisfy. The schema is
 * carried as it arrived: the editor reads it, and everything it does not
 * understand stays legible in the JSON surface rather than being dropped here.
 */
const brokerHostPolicySchema = z.object({
  authorization: z.enum(['grants', 'owner']).optional(),
  removable: z.boolean().optional(),
  selectableAgent: z.boolean().optional(),
})
const contributionTypeSchema = z.object({
  extensionId: z.string().min(1),
  host: brokerHostPolicySchema.readonly().optional(),
  instances: z.enum(['many', 'single']),
  schema: z.record(z.string(), z.unknown()),
  type: z.string().min(1),
})
const toolSetTypesSchema = z.object({ toolSetTypes: z.array(contributionTypeSchema) })
const sectionTypesSchema = z.object({ types: z.array(contributionTypeSchema) })

const savedSectionSchema = configSectionSchema.extend({
  restartRequired: z.boolean(),
  revertAvailable: revertAvailableSchema,
  runtime: runtimeComponentsSchema,
})
const savedEntrySchema = configEntrySchema.extend({
  restartRequired: z.boolean(),
  revertAvailable: revertAvailableSchema,
  runtime: runtimeComponentsSchema,
})
const removedEntrySchema = z.object({
  entryId: z.string().min(1),
  restartRequired: z.boolean(),
  revertAvailable: revertAvailableSchema,
  runtime: runtimeComponentsSchema,
  section: z.string().min(1),
})

const secretConsumerSchema = z.object({
  extensionId: z.string().min(1),
  location: z.string().min(1),
})

/** One place configuration names this ID. The same ID may be named many times. */
const secretReferenceSchema = z.object({
  location: z.string().min(1),
  secretId: z.string().min(1),
})

/**
 * A secret is a name first and a value second. `stored` is which of the two this
 * row has: named by configuration with nothing stored for it is the ordinary
 * state of a fresh install, and the timestamps only exist once something was
 * written.
 */
const secretSchema = z.object({
  consumers: z.array(secretConsumerSchema),
  createdAt: z.number().int().nonnegative().optional(),
  references: z.array(secretReferenceSchema),
  restartRequired: z.boolean(),
  secretId: z.string().min(1),
  stored: z.boolean(),
  updatedAt: z.number().int().nonnegative().optional(),
})

const secretsSchema = z.object({ secrets: z.array(secretSchema) })
const removedSecretSchema = z.object({
  consumers: z.array(secretConsumerSchema),
  references: z.array(secretReferenceSchema),
  restartRequired: z.boolean(),
  secretId: z.string().min(1),
})

type AuthoritySummary = z.infer<typeof authoritySummarySchema>
type ConfigCatalog = z.infer<typeof configCatalogSchema>
type ContributionSummary = z.infer<typeof contributionSummarySchema>
type ContributionType = z.infer<typeof contributionTypeSchema>
type ConfigEntry = z.infer<typeof configEntrySchema>
type ConfigSection = z.infer<typeof configSectionSchema>
type ConfigValue = z.infer<typeof configValueSchema>
type RemovedEntry = z.infer<typeof removedEntrySchema>
type RuntimeComponent = z.infer<typeof runtimeComponentSchema>
type RuntimeRecovery = z.infer<typeof runtimeStatusSchema>
type RemovedSecret = z.infer<typeof removedSecretSchema>
type SavedEntry = z.infer<typeof savedEntrySchema>
type SavedSection = z.infer<typeof savedSectionSchema>
type Secret = z.infer<typeof secretSchema>
type SecretReference = z.infer<typeof secretReferenceSchema>
type SectionSummary = z.infer<typeof sectionSummarySchema>
type ProviderInventory = z.infer<typeof providerInventorySchema>
type ProviderModelInventory = z.infer<typeof providerModelInventorySchema>
type ToolInventory = z.infer<typeof toolInventorySchema>
type ToolSetInventory = z.infer<typeof toolSetInventorySchema>
type ToolSetType = ContributionType

interface EntryInput {
  readonly accessToken: string
  readonly entryId: string
  readonly section: string
}

interface SaveEntryInput extends EntryInput {
  readonly value: ConfigValue
}

interface SaveSectionInput {
  readonly accessToken: string
  readonly section: string
  readonly value: ConfigValue
}

interface SecretInput {
  readonly accessToken: string
  readonly secretId: string
}

interface SaveSecretInput extends SecretInput {
  readonly value: string
}

interface SettingsApi {
  createEntry(input: SaveEntryInput): Promise<SavedEntry>
  deleteEntry(input: EntryInput): Promise<RemovedEntry>
  deleteSecret(input: SecretInput): Promise<RemovedSecret>
  listConfig(accessToken: string): Promise<ConfigCatalog>
  listProviderInventory(
    accessToken: string,
    refresh?: boolean,
  ): Promise<readonly ProviderInventory[]>
  listSecrets(accessToken: string): Promise<readonly Secret[]>
  listSectionTypes(accessToken: string, section: string): Promise<readonly ToolSetType[]>
  listToolSetInventory(accessToken: string): Promise<readonly ToolSetInventory[]>
  listToolSetTypes(accessToken: string): Promise<readonly ToolSetType[]>
  readEntry(input: EntryInput): Promise<ConfigEntry>
  readSection(accessToken: string, section: string): Promise<ConfigSection>
  reloadConfiguration(accessToken: string): Promise<ConfigCatalog>
  retryRuntime(accessToken: string): Promise<RuntimeRecovery>
  revertRuntime(accessToken: string): Promise<RuntimeRecovery>
  replaceEntry(input: SaveEntryInput): Promise<SavedEntry>
  replaceSection(input: SaveSectionInput): Promise<SavedSection>
  saveSecret(input: SaveSecretInput): Promise<Secret>
}

function authorization(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}` }
}

function jsonRequest(accessToken: string, method: 'POST' | 'PUT', value: unknown): RequestInit {
  return {
    body: JSON.stringify(value),
    headers: authorization(accessToken),
    method,
  }
}

function entryPath(section: string, entryId: string): string {
  return `/config/${encodeURIComponent(section)}/${encodeURIComponent(entryId)}`
}

function secretPath(secretId: string): string {
  return `/secrets/${encodeURIComponent(secretId)}`
}

const settingsApi: SettingsApi = {
  createEntry({ accessToken, entryId, section, value }) {
    return requestJson(
      entryPath(section, entryId),
      savedEntrySchema,
      jsonRequest(accessToken, 'POST', value),
    )
  },

  deleteEntry({ accessToken, entryId, section }) {
    return requestJson(entryPath(section, entryId), removedEntrySchema, {
      headers: authorization(accessToken),
      method: 'DELETE',
    })
  },

  deleteSecret({ accessToken, secretId }) {
    return requestJson(secretPath(secretId), removedSecretSchema, {
      headers: authorization(accessToken),
      method: 'DELETE',
    })
  },

  listConfig(accessToken) {
    return requestJson('/config', configCatalogSchema, { headers: authorization(accessToken) })
  },

  /**
   * What each configured provider serves. `refresh` re-asks the endpoints
   * rather than reusing what they last said, for an operator who has just
   * changed the other side.
   */
  async listProviderInventory(accessToken, refresh = false) {
    const response = await requestJson(
      refresh ? '/capabilities/providers?refresh=1' : '/capabilities/providers',
      providerInventoriesSchema,
      { headers: authorization(accessToken) },
    )
    return response.providers
  },

  async listSecrets(accessToken) {
    const response = await requestJson('/secrets', secretsSchema, {
      headers: authorization(accessToken),
    })
    return response.secrets
  },

  async listToolSetInventory(accessToken) {
    const response = await requestJson('/capabilities/tool-sets', toolSetInventoriesSchema, {
      headers: authorization(accessToken),
    })
    return response.toolSets
  },

  /**
   * The kinds one contributed section may hold, each with its own schema. Every
   * editor of a contributed section renders its form from this rather than from
   * a copy of what an extension's configuration used to look like.
   */
  async listSectionTypes(accessToken, section) {
    const response = await requestJson(
      `/config/${encodeURIComponent(section)}/types`,
      sectionTypesSchema,
      { headers: authorization(accessToken) },
    )
    return response.types
  },

  async listToolSetTypes(accessToken) {
    const response = await requestJson('/capabilities/tool-set-types', toolSetTypesSchema, {
      headers: authorization(accessToken),
    })
    return response.toolSetTypes
  },

  readEntry({ accessToken, entryId, section }) {
    return requestJson(entryPath(section, entryId), configEntrySchema, {
      headers: authorization(accessToken),
    })
  },

  readSection(accessToken, section) {
    return requestJson(`/config/${encodeURIComponent(section)}`, configSectionSchema, {
      headers: authorization(accessToken),
    })
  },

  reloadConfiguration(accessToken) {
    return requestJson(
      '/config/reload',
      configCatalogSchema,
      jsonRequest(accessToken, 'POST', {}),
    )
  },

  retryRuntime(accessToken) {
    return requestJson(
      '/config/runtime/retry',
      runtimeStatusSchema,
      jsonRequest(accessToken, 'POST', {}),
    )
  },

  revertRuntime(accessToken) {
    return requestJson(
      '/config/runtime/revert',
      runtimeStatusSchema,
      jsonRequest(accessToken, 'POST', {}),
    )
  },

  replaceEntry({ accessToken, entryId, section, value }) {
    return requestJson(
      entryPath(section, entryId),
      savedEntrySchema,
      jsonRequest(accessToken, 'PUT', value),
    )
  },

  replaceSection({ accessToken, section, value }) {
    return requestJson(
      `/config/${encodeURIComponent(section)}`,
      savedSectionSchema,
      jsonRequest(accessToken, 'PUT', value),
    )
  },

  saveSecret({ accessToken, secretId, value }) {
    return requestJson(
      secretPath(secretId),
      secretSchema,
      jsonRequest(accessToken, 'PUT', { value }),
    )
  },
}

export { settingsApi }

export type {
  AuthoritySummary,
  ConfigCatalog,
  ConfigEntry,
  ConfigSection,
  ConfigValue,
  ContributionSummary,
  ContributionType,
  ProviderInventory,
  ProviderModelInventory,
  RemovedEntry,
  RemovedSecret,
  RuntimeComponent,
  RuntimeRecovery,
  SavedEntry,
  SavedSection,
  Secret,
  SecretReference,
  SectionSummary,
  SettingsApi,
  ToolInventory,
  ToolSetInventory,
  ToolSetType,
}
