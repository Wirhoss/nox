import { z } from 'zod'

import { requestEmpty, requestJson } from '@/shared/api/http'

const memorySummarySchema = z.object({
  editable: z.boolean(),
  id: z.string(),
  inspectable: z.boolean(),
})
const memoriesSchema = z.object({ memories: z.array(memorySummarySchema) })

const scopeSchema = z.object({
  accessCount: z.number().int().nonnegative(),
  agentId: z.string(),
  episodeCount: z.number().int().nonnegative(),
  factCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().optional(),
  liveFactCount: z.number().int().nonnegative(),
  principal: z.object({ issuer: z.string(), subject: z.string() }),
})
const scopesSchema = z.object({ scopes: z.array(scopeSchema) })

const provenanceSchema = z.object({
  completedAt: z.string(),
  episodeId: z.string(),
  sessionId: z.string(),
  trigger: z.string(),
})
const factSchema = z.object({
  accessCount: z.number().int().nonnegative(),
  confidence: z.number(),
  createdAt: z.string(),
  id: z.string(),
  invalidatedAt: z.string().optional(),
  invalidatedBy: z.string().optional(),
  invalidatedEpisodeId: z.string().optional(),
  kind: z.string(),
  lastAccessedAt: z.string().optional(),
  provenance: z.array(provenanceSchema),
  supportCount: z.number().int().nonnegative(),
  text: z.string(),
  validFrom: z.string(),
  validTo: z.string().optional(),
})
const episodeSchema = z.object({
  completedAt: z.string(),
  episodeId: z.string(),
  extractedAt: z.string().optional(),
  factIds: z.array(z.string()),
  runId: z.string(),
  sessionId: z.string(),
  startedAt: z.string(),
  status: z.string(),
  transcript: z.string(),
  trigger: z.string(),
})

function pageSchema<Entry extends z.ZodTypeAny>(entry: Entry) {
  return z.object({
    entries: z.array(entry),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
}

const factPageSchema = pageSchema(factSchema)
const episodePageSchema = pageSchema(episodeSchema)
const writtenFactSchema = z.object({ fact: z.object({ id: z.string() }).passthrough() })

type MemorySummary = z.infer<typeof memorySummarySchema>
type MemoryScopeSummary = z.infer<typeof scopeSchema>
type MemoryFact = z.infer<typeof factSchema>
type MemoryEpisode = z.infer<typeof episodeSchema>
type MemoryFactPage = z.infer<typeof factPageSchema>
type MemoryEpisodePage = z.infer<typeof episodePageSchema>

interface ScopeSelector {
  readonly agentId: string
  readonly issuer: string
  readonly subject: string
}

interface PageSelector extends ScopeSelector {
  readonly limit: number
  readonly offset: number
}

/** The audited scope, as the query string every inspection route expects. */
function scopeQuery(selector: PageSelector): string {
  return new URLSearchParams({
    agentId: selector.agentId,
    issuer: selector.issuer,
    limit: String(selector.limit),
    offset: String(selector.offset),
    subject: selector.subject,
  }).toString()
}

/**
 * The bearer header every memory route needs.
 *
 * Passed per call rather than held here, because the shared `request` sends
 * cookies and nothing else: a client that forgot this got a 401 that read as
 * the memory being unavailable rather than as the request being unsigned.
 */
function authorization(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` }
}

const memoryApi = {
  episodes(
    accessToken: string,
    memoryId: string,
    selector: PageSelector,
  ): Promise<MemoryEpisodePage> {
    return requestJson(
      `/memories/${encodeURIComponent(memoryId)}/episodes?${scopeQuery(selector)}`,
      episodePageSchema,
      { headers: authorization(accessToken) },
    )
  },

  facts(accessToken: string, memoryId: string, selector: PageSelector): Promise<MemoryFactPage> {
    return requestJson(
      `/memories/${encodeURIComponent(memoryId)}/facts?${scopeQuery(selector)}`,
      factPageSchema,
      { headers: authorization(accessToken) },
    )
  },

  /** Retirement, not erasure: the fact stays readable as history. */
  forget(
    accessToken: string,
    memoryId: string,
    factId: string,
    selector: ScopeSelector,
  ): Promise<void> {
    const query = new URLSearchParams({
      agentId: selector.agentId,
      issuer: selector.issuer,
      subject: selector.subject,
    }).toString()
    return requestEmpty(
      `/memories/${encodeURIComponent(memoryId)}/facts/${encodeURIComponent(factId)}?${query}`,
      { headers: authorization(accessToken), method: 'DELETE' },
    )
  },

  list(accessToken: string): Promise<readonly MemorySummary[]> {
    return requestJson('/memories', memoriesSchema, {
      headers: authorization(accessToken),
    }).then((body) => body.memories)
  },

  scopes(accessToken: string, memoryId: string): Promise<readonly MemoryScopeSummary[]> {
    return requestJson(`/memories/${encodeURIComponent(memoryId)}/scopes`, scopesSchema, {
      headers: authorization(accessToken),
    }).then((body) => body.scopes)
  },

  update(
    accessToken: string,
    memoryId: string,
    factId: string,
    body: { agentId: string; issuer: string; kind: string; subject: string; text: string },
  ): Promise<void> {
    return requestJson(
      `/memories/${encodeURIComponent(memoryId)}/facts/${encodeURIComponent(factId)}`,
      writtenFactSchema,
      {
        body: JSON.stringify(body),
        headers: { ...authorization(accessToken), 'content-type': 'application/json' },
        method: 'PUT',
      },
    ).then(() => undefined)
  },
}

export { memoryApi }

export type {
  MemoryEpisode,
  MemoryEpisodePage,
  MemoryFact,
  MemoryFactPage,
  MemoryScopeSummary,
  MemorySummary,
  PageSelector,
  ScopeSelector,
}
