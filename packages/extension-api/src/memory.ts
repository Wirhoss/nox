import type { PrincipalRef } from './content.js';
import type { MaybePromise } from './core.js';

/**
 * The security and ownership boundary for one memory operation.
 *
 * `agentId` is always present because memories belong to an agent, never to the
 * Nox installation as a whole. `principal` further isolates participants inside
 * shared conversations; an adapter must not broaden either boundary.
 */
interface MemoryScope {
  readonly agentId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly principal: PrincipalRef;
  readonly sessionId: string;
}

/** A provider-neutral, text projection of one conversational message. */
interface MemoryMessage {
  readonly createdAt: Date;
  /**
   * What the transport called this speaker, when it had a name for it.
   *
   * Presentation only, exactly as on `MessageOrigin`: `principal` remains what
   * anything is decided from. It travels with the projection so a memory read
   * back months later still says who spoke, instead of arriving as unattributed
   * text the model has to guess an owner for.
   */
  readonly displayName?: string;
  readonly messageId: string;
  readonly principal?: PrincipalRef;
  readonly role: 'assistant' | 'user';
  readonly text: string;
}

/** One independently attributable result returned by a memory implementation. */
interface RecalledMemory {
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly uri?: string;
}

interface MemoryRecallRequest {
  /** Bounded conversational context. Implementations may ignore it when `query` is sufficient. */
  readonly context: readonly MemoryMessage[];
  /** The current turn expressed as plain text for backends with a query API. */
  readonly query: string;
  /** Maximum memory payload the implementation should return, measured in model tokens. */
  readonly maxTokens: number;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

interface MemoryRecallResult {
  readonly memories: readonly RecalledMemory[];
}

/** A current, independently editable item exposed by a memory implementation. */
/**
 * The kinds of fact a memory tells apart, because each is superseded differently.
 * Here rather than inside one implementation because both ends must agree: the
 * extractor picks from this list, and so does the agent when it writes a fact by
 * hand. They disagreed once, and consolidation then refused to compare the
 * results because it matches on kind.
 *
 * identity: who they are and what does not change. preference: what they like
 * or want done. decision: something settled that later work depends on. state:
 * something true of them for now, which will change again.
 */
const MEMORY_FACT_KINDS = ['decision', 'identity', 'preference', 'state'] as const;

type MemoryFactKind = (typeof MEMORY_FACT_KINDS)[number];

interface MemoryRecord {
  readonly id: string;
  readonly kind?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly validFrom?: string;
  readonly validTo?: string;
}

interface MemorySearchRequest {
  readonly limit: number;
  readonly query: string;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

interface MemoryWriteRequest {
  /**
   * Closed, unlike the `kind` a record reads back with. A store may hold facts
   * written under a vocabulary that no longer exists and must keep answering
   * with them; nothing may add to that vocabulary now.
   */
  readonly kind: MemoryFactKind;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
  readonly text: string;
  readonly validFrom?: string;
}

interface MemoryUpdateRequest extends MemoryWriteRequest {
  readonly id: string;
}

interface MemoryForgetRequest {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
  readonly validTo?: string;
}

/** Principal ownership without a conversation-local session. Used only by owner audit surfaces. */
interface MemoryOwnerScope {
  readonly agentId: string;
  readonly principal: PrincipalRef;
}

interface MemoryInspectionQuery {
  readonly limit: number;
  readonly offset: number;
  readonly scope?: MemoryOwnerScope;
  readonly signal: AbortSignal;
}

interface MemoryFactInspection extends MemoryRecord {
  readonly accessCount: number;
  readonly confidence: number;
  readonly createdAt: string;
  readonly invalidatedAt?: string;
  readonly invalidatedBy?: string;
  readonly invalidatedEpisodeId?: string;
  readonly lastAccessedAt?: string;
  readonly provenance: readonly MemoryFactProvenance[];
  readonly supportCount: number;
}

interface MemoryFactProvenance {
  readonly completedAt: string;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly trigger: string;
}

interface MemoryEpisodeInspection {
  readonly completedAt: string;
  readonly episodeId: string;
  readonly extractedAt?: string;
  readonly factIds: readonly string[];
  readonly runId: string;
  readonly scope: MemoryOwnerScope;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly status: string;
  readonly transcript: string;
  readonly trigger: string;
}

interface MemoryScopeInspection extends MemoryOwnerScope {
  readonly accessCount: number;
  readonly episodeCount: number;
  readonly factCount: number;
  readonly lastActivityAt?: string;
  readonly liveFactCount: number;
}

interface MemoryInspectionPage<T> {
  readonly entries: readonly T[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

/** Owner-facing audit projection. It is never exposed as an agent tool. */
interface MemoryInspector {
  episodes(
    request: MemoryInspectionQuery,
  ): MaybePromise<MemoryInspectionPage<MemoryEpisodeInspection>>;
  facts(request: MemoryInspectionQuery): MaybePromise<MemoryInspectionPage<MemoryFactInspection>>;
  scopes(signal: AbortSignal): MaybePromise<readonly MemoryScopeInspection[]>;
}

/**
 * Optional explicit editing surface behind Nox's standard memory tools.
 *
 * The host supplies the same principal-bound scope used by conversational recall.
 * IDs remain opaque to the host, and implementations must enforce that scope again
 * in storage before reading or mutating one.
 */
interface MemoryEditor {
  forget(request: MemoryForgetRequest): MaybePromise<boolean>;
  search(request: MemorySearchRequest): MaybePromise<readonly MemoryRecord[]>;
  update(request: MemoryUpdateRequest): MaybePromise<MemoryRecord | undefined>;
  write(request: MemoryWriteRequest): MaybePromise<MemoryRecord>;
}

/**
 * One always-present piece of the agent's own memory.
 *
 * Unlike a recalled fact, a block is not retrieved: it is in the system prompt
 * of every request whether or not the conversation went near it. That is what
 * makes it the right home for the handful of things an agent must never have to
 * look up — who it is talking to, what it was asked to be — and the reason
 * blocks are declared by an agent's blueprint rather than created at will. A
 * store that could grow new always-present text on its own would be a store
 * that could grow the system prompt on its own.
 */
interface MemoryBlock {
  /** What this block is for, shown to the model beside the value. */
  readonly description?: string;
  /** The stable identifier the blueprint declared and a tool addresses. */
  readonly label: string;
  readonly updatedAt?: string;
  readonly value: string;
}

/** What an agent's blueprint says one of its blocks is for. */
interface MemoryBlockDeclaration {
  readonly description?: string;
  readonly label: string;
}

interface MemoryBlockReadRequest {
  /** The declared labels, in the order the blueprint gave them. */
  readonly labels: readonly string[];
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

interface MemoryBlockWriteRequest {
  readonly label: string;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
  readonly value: string;
}

/**
 * Optional always-present memory an agent carries in its system prompt.
 *
 * Absent means this memory keeps only what it recalls. Nox decides which labels
 * exist and enforces the limit on each; the implementation owns their storage
 * and must scope them exactly as it scopes a fact.
 */
interface MemoryBlocks {
  read(request: MemoryBlockReadRequest): MaybePromise<readonly MemoryBlock[]>;
  write(request: MemoryBlockWriteRequest): MaybePromise<MemoryBlock>;
}

type MemoryRunStatus = 'aborted' | 'completed' | 'failed' | 'maxIterations';
type MemoryRunTrigger = 'cron' | 'deferredResult' | 'retry' | 'steer' | 'user';

interface MemoryRetainRequest {
  readonly completedAt: Date;
  /** Only the non-derived user/assistant delta produced by this run. */
  readonly messages: readonly MemoryMessage[];
  readonly runId: string;
  readonly scope: MemoryScope;
  readonly startedAt: Date;
  readonly status: MemoryRunStatus;
  readonly trigger: MemoryRunTrigger;
}

/**
 * Long-term memory attached to one configured agent generation.
 *
 * Implementations own storage, extraction, consolidation and retrieval. Nox owns
 * operation timing, security scope and ephemeral injection into model context.
 */
interface Memory {
  /** Absent means this memory carries nothing in the system prompt. */
  readonly blocks?: MemoryBlocks;
  /** Absent means this memory cannot be granted the standard editing tools. */
  readonly editor?: MemoryEditor;
  /** Absent means this memory has no owner-facing audit projection. */
  readonly inspector?: MemoryInspector;
  recall(request: MemoryRecallRequest): MaybePromise<MemoryRecallResult>;
  retain(request: MemoryRetainRequest): MaybePromise<void>;
}

export { MEMORY_FACT_KINDS };

export type {
  Memory,
  MemoryBlock,
  MemoryBlockDeclaration,
  MemoryBlockReadRequest,
  MemoryBlocks,
  MemoryBlockWriteRequest,
  MemoryEditor,
  MemoryEpisodeInspection,
  MemoryFactInspection,
  MemoryFactKind,
  MemoryFactProvenance,
  MemoryForgetRequest,
  MemoryInspectionPage,
  MemoryInspectionQuery,
  MemoryInspector,
  MemoryMessage,
  MemoryOwnerScope,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRetainRequest,
  MemoryRunStatus,
  MemoryRunTrigger,
  MemoryScope,
  MemoryScopeInspection,
  MemorySearchRequest,
  MemoryUpdateRequest,
  MemoryWriteRequest,
  RecalledMemory,
};
