import { z } from 'zod'

import { requestJson } from '@/shared/api/http'

const configValueSchema = z.record(z.string(), z.unknown())

const sectionSummarySchema = z.object({
  applies: z.enum(['hot', 'restart']),
  entries: z.boolean(),
  key: z.string().min(1),
  kind: z.enum(['contribution', 'directory', 'file']),
  loaded: z.boolean(),
  name: z.string().min(1),
  writable: z.boolean(),
})

const configCatalogSchema = z.object({
  defaultAgent: z.string().min(1).optional(),
  sections: z.array(sectionSummarySchema),
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
 * One configurable kind and the schema its entries must satisfy. The schema is
 * carried as it arrived: the editor reads it, and everything it does not
 * understand stays legible in the JSON surface rather than being dropped here.
 */
const toolSetTypeSchema = z.object({
  extensionId: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
  type: z.string().min(1),
})
const toolSetTypesSchema = z.object({ toolSetTypes: z.array(toolSetTypeSchema) })

const savedSectionSchema = configSectionSchema.extend({ restartRequired: z.boolean() })
const savedEntrySchema = configEntrySchema.extend({ restartRequired: z.boolean() })
const removedEntrySchema = z.object({
  entryId: z.string().min(1),
  restartRequired: z.boolean(),
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

type ConfigCatalog = z.infer<typeof configCatalogSchema>
type ConfigEntry = z.infer<typeof configEntrySchema>
type ConfigSection = z.infer<typeof configSectionSchema>
type ConfigValue = z.infer<typeof configValueSchema>
type RemovedEntry = z.infer<typeof removedEntrySchema>
type RemovedSecret = z.infer<typeof removedSecretSchema>
type SavedEntry = z.infer<typeof savedEntrySchema>
type SavedSection = z.infer<typeof savedSectionSchema>
type Secret = z.infer<typeof secretSchema>
type SecretReference = z.infer<typeof secretReferenceSchema>
type SectionSummary = z.infer<typeof sectionSummarySchema>
type ToolInventory = z.infer<typeof toolInventorySchema>
type ToolSetInventory = z.infer<typeof toolSetInventorySchema>
type ToolSetType = z.infer<typeof toolSetTypeSchema>

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
  listSecrets(accessToken: string): Promise<readonly Secret[]>
  listToolSetInventory(accessToken: string): Promise<readonly ToolSetInventory[]>
  listToolSetTypes(accessToken: string): Promise<readonly ToolSetType[]>
  readEntry(input: EntryInput): Promise<ConfigEntry>
  readSection(accessToken: string, section: string): Promise<ConfigSection>
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
  ConfigCatalog,
  ConfigEntry,
  ConfigSection,
  ConfigValue,
  RemovedEntry,
  RemovedSecret,
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
