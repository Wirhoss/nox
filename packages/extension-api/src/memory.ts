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
  recall(request: MemoryRecallRequest): MaybePromise<MemoryRecallResult>;
  retain(request: MemoryRetainRequest): MaybePromise<void>;
}

export type {
  Memory,
  MemoryMessage,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetainRequest,
  MemoryRunStatus,
  MemoryRunTrigger,
  MemoryScope,
  RecalledMemory,
};
