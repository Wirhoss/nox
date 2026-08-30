import { calibrateFloor, NEAREST_QUANTILE, PROBES } from './calibration';
import { NO_FLOOR } from './config';
import { judgeContradiction } from './contradiction';
import { extract } from './extraction';
import {
  type DraftFact,
  type FactAccess,
  type FactOperation,
  partitionKey,
  type RankedFact,
  type Reinforcement,
  type Scope,
  scopeOf,
  type SemanticStore,
  type StoredFact,
  type VectorIdentity,
} from './store';

import type {
  ChatModel,
  Disposable,
  EmbeddingModel,
  Logger,
  Memory,
  MemoryBlock,
  MemoryBlockReadRequest,
  MemoryBlocks,
  MemoryBlockWriteRequest,
  MemoryEditor,
  MemoryEpisodeInspection,
  MemoryFactInspection,
  MemoryForgetRequest,
  MemoryInspectionPage,
  MemoryInspectionQuery,
  MemoryInspector,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRetainRequest,
  MemoryScopeInspection,
  MemorySearchRequest,
  MemoryUpdateRequest,
  MemoryWriteRequest,
  RecalledMemory,
  RuntimeActivity,
} from '@nox/extension-api';

/** Same estimate the runner budgets with; a recall is bounded before it is rendered. */
const CHARACTERS_PER_TOKEN = 3;

/** How many turns one background pass drains before yielding. */
const EXTRACTION_BATCH = 4;

/** A candidate costs two indexed reads and no model, unlike backfill's bulk statement. */
const CONSOLIDATION_BATCH = 32;

/** Small: each candidate is a model call, and four costs about what one extraction turn costs. */
const CONTRADICTION_BATCH = 4;

/** How many recent live beliefs a contradiction scan looks among. */
const CONTRADICTION_SCAN = 64;

/** A block sits in every system prompt; this keeps an always-present note from becoming a second transcript. */
const MAX_BLOCK_CHARACTERS = 2_000;

/** Matches the shipped `mergeDistance`, for a memory built without one. */
const DEFAULT_MERGE_DISTANCE = 0.25;

/** How many facts one pass re-embeds after a model change. */
const BACKFILL_BATCH = 64;

/** Successful recalls accumulated before durability is worth one background write. */
const ACCESS_FLUSH_THRESHOLD = 32;

/** How much of the corpus the extractor is shown as currently believed. */
const BELIEF_WINDOW = 100;

/** Older semantic neighbours reserved inside the belief window once it overflows. */
const OLDER_BELIEF_CANDIDATES = 20;

/** Matches the transcript slice extraction itself can read. */
const BELIEF_QUERY_CHARACTERS = 12_000;

/** The only thing that runs when idle; cheap on purpose so it never keeps the machine awake. */
const DREAM_TICK_MS = 30_000;

/** When the memory may spend the extraction model. See the config schema. */
interface DreamPolicy {
  readonly episodes: number;
  readonly idleSeconds: number;
  readonly maxDelaySeconds: number;
}

const DEFAULT_DREAM_POLICY: DreamPolicy = Object.freeze({
  episodes: 8,
  idleSeconds: 90,
  maxDelaySeconds: 1_800,
});

interface SemanticMemoryOptions {
  /** Whether someone is waiting on Nox; absent, the policy falls back to backlog and ceiling. */
  readonly activity?: RuntimeActivity;
  readonly chat: ChatModel;
  /** Upper edge of the band put to the model as a possible contradiction. Zero disables it. */
  readonly contradictionDistance?: number;
  readonly dream?: DreamPolicy;
  readonly embedding: EmbeddingModel;
  readonly logger?: Logger;
  /** An operator's pinned floor. Absent, the model's own geometry supplies one. */
  readonly maxDistance?: number;
  readonly maxRecallFacts: number;
  /** How close two facts must be to be folded into one. Zero stops merging. */
  readonly mergeDistance?: number;
  readonly store: SemanticStore;
}

interface Vectored {
  readonly factId: number;
  readonly vector: readonly number[];
}

/** How a fact reads once it is out of the store and in front of the model. */
function render(fact: StoredFact): string {
  const ended = fact.validTo === undefined ? '' : ` (until ${fact.validTo})`;
  return `[${fact.kind}] ${fact.text}${ended}`;
}

function editableRecord(
  fact: StoredFact,
  metadata?: Readonly<Record<string, unknown>>,
): MemoryRecord {
  return Object.freeze({
    id: String(fact.factId),
    kind: fact.kind,
    ...(metadata === undefined ? {} : { metadata: Object.freeze(metadata) }),
    text: fact.text,
    validFrom: fact.validFrom,
    ...(fact.validTo === undefined ? {} : { validTo: fact.validTo }),
  });
}

function editableFactId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new TypeError(`Invalid memory fact ID "${value}".`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new TypeError(`Invalid memory fact ID "${value}".`);
  return id;
}

function boundedText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw new RangeError(`${label} must contain between 1 and ${String(maximum)} characters.`);
  }
  return trimmed;
}

function timestamp(value: string | undefined, fallback: Date, label: string): string {
  if (value === undefined) return fallback.toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO 8601 timestamp.`);
  return new Date(parsed).toISOString();
}

function operation(
  sessionId: string,
  trigger: FactOperation['trigger'],
  transcript: string,
): FactOperation {
  return {
    runId: `${trigger}:${crypto.randomUUID()}`,
    sessionId,
    transcript,
    trigger,
  };
}

/**
 * Long-term memory: episodes as they happened, facts extracted from them, and
 * retrieval over both. Recall is per fact — what remained true afterwards — but
 * turns stay, because a fact without provenance cannot be checked or re-extracted.
 */
class SemanticMemory implements Disposable, Memory, MemoryEditor, MemoryInspector {
  readonly #activity?: RuntimeActivity;
  readonly #chat: ChatModel;
  readonly #dream: DreamPolicy;
  readonly #embedding: EmbeddingModel;
  readonly #lifetime = new AbortController();
  readonly #logger?: Logger;
  readonly #maxDistance?: number;
  readonly #maxRecallFacts: number;
  readonly #contradictionDistance: number;
  readonly #mergeDistance: number;
  readonly #store: SemanticStore;

  #accesses = new Map<number, FactAccess>();
  #accessTotal = 0;
  #backfilling = false;
  /** Decided once, before the pass: a pass started by the ceiling must not yield to the traffic it overrides. */
  #overdue = false;
  /** When the runtime was first seen quiet in the stretch of quiet still running. */
  #quietSince?: number;
  #tick?: ReturnType<typeof setInterval>;
  /** The floor measured for this model, once asked. Cached only on success. */
  #calibrated?: number;
  /** The single background pass. Serialised by chaining, never by overlapping. */
  #pass: Promise<void> = Promise.resolve();
  #started?: Promise<void>;

  constructor(options: SemanticMemoryOptions) {
    if (options.activity !== undefined) this.#activity = options.activity;
    this.#chat = options.chat;
    this.#dream = options.dream ?? DEFAULT_DREAM_POLICY;
    this.#embedding = options.embedding;
    this.#logger = options.logger;
    // Assigned only when set, so an unset floor stays undefined under
    // `exactOptionalPropertyTypes` rather than becoming an explicit absence.
    if (options.maxDistance !== undefined) this.#maxDistance = options.maxDistance;
    this.#maxRecallFacts = options.maxRecallFacts;
    this.#contradictionDistance = options.contradictionDistance ?? 0;
    this.#mergeDistance = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
    this.#store = options.store;
  }

  /** Awaited by the runtime so a pass is never killed between the writes of one transaction. */
  public async dispose(): Promise<void> {
    this.#lifetime.abort();
    if (this.#tick !== undefined) clearInterval(this.#tick);
    await this.#pass.catch(() => undefined);
    try {
      await this.#flushAccesses();
    } catch (error) {
      // Usage is a ranking hint, not a fact; it must not block disposal.
      this.#logger?.warn({ err: error }, 'Could not persist the final memory access batch.');
    }
  }

  /** Delegated so `MemoryBlocks.write` and `MemoryEditor.write` can keep their own names. */
  public get blocks(): MemoryBlocks {
    return {
      read: (request) => this.readBlocks(request),
      write: (request) => this.writeBlock(request),
    };
  }

  public get editor(): MemoryEditor {
    return this;
  }

  /** Only declared blocks with a value, in the blueprint's order. */
  public async readBlocks(request: MemoryBlockReadRequest): Promise<readonly MemoryBlock[]> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    const stored = await this.#store.readBlocks(scopeOf(request.scope), request.labels);
    const byLabel = new Map(stored.map((block) => [block.label, block]));
    return request.labels.flatMap((label): MemoryBlock[] => {
      const block = byLabel.get(label);
      return block === undefined
        ? []
        : [{ label, updatedAt: block.updatedAt, value: block.value }];
    });
  }

  public async writeBlock(request: MemoryBlockWriteRequest): Promise<MemoryBlock> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    const label = boundedText(request.label, 'Memory block label', 64);
    // Blanking a block is how an agent says it no longer knows something.
    const value = request.value.trim();
    if (value.length > MAX_BLOCK_CHARACTERS) {
      throw new RangeError(
        `A memory block may hold at most ${String(MAX_BLOCK_CHARACTERS)} characters.`,
      );
    }
    const written = await this.#store.writeBlock(
      scopeOf(request.scope),
      label,
      value,
      new Date(),
    );
    return { label: written.label, updatedAt: written.updatedAt, value: written.value };
  }

  public get inspector(): MemoryInspector {
    return this;
  }

  public async scopes(signal: AbortSignal): Promise<readonly MemoryScopeInspection[]> {
    this.#available(signal);
    const scopes = await this.#store.inspectionScopes();
    this.#available(signal);
    return scopes;
  }

  public async facts(
    request: MemoryInspectionQuery,
  ): Promise<MemoryInspectionPage<MemoryFactInspection>> {
    this.#assertInspectionQuery(request);
    const page = await this.#store.inspectFacts(request);
    this.#available(request.signal);
    return page;
  }

  public async episodes(
    request: MemoryInspectionQuery,
  ): Promise<MemoryInspectionPage<MemoryEpisodeInspection>> {
    this.#assertInspectionQuery(request);
    const page = await this.#store.inspectEpisodes(request);
    this.#available(request.signal);
    return page;
  }

  /** Explicit search propagates backend failures so the calling tool can report them. */
  public async search(request: MemorySearchRequest): Promise<readonly MemoryRecord[]> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 20) {
      throw new RangeError('Memory search limit must be an integer between 1 and 20.');
    }
    const query = boundedText(request.query, 'Memory search query', 2_000);
    const scope = scopeOf(request.scope);
    const nearest = await this.#rank(
      scope,
      query,
      Math.min(request.limit, this.#maxRecallFacts),
      request.signal,
      new Date(),
    );
    const facts = new Map(
      (
        await this.#store.factsByIds(
          scope,
          nearest.map(({ factId }) => factId),
        )
      ).map((fact) => [fact.factId, fact]),
    );
    request.signal.throwIfAborted();

    const accessed: number[] = [];
    const records = nearest.flatMap((hit): MemoryRecord[] => {
      const fact = facts.get(hit.factId);
      if (fact === undefined) return [];
      accessed.push(fact.factId);
      return [
        // Only the support count: ranking internals would make the model reason about
        // its own retrieval; they stay on the owner-facing inspection.
        editableRecord(fact, { supportCount: hit.supportCount }),
      ];
    });
    this.#rememberAccesses(scope, accessed, new Date());
    return Object.freeze(records);
  }

  public async write(request: MemoryWriteRequest): Promise<MemoryRecord> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    const at = new Date();
    const kind = boundedText(request.kind, 'Memory fact kind', 64);
    const text = boundedText(request.text, 'Memory fact text', 4_000);
    const validFrom = timestamp(request.validFrom, at, 'validFrom');
    const vector = await this.#vectorFor(text, request.signal);
    const fact = await this.#store.writeFact(
      scopeOf(request.scope),
      { kind, text, validFrom },
      vector,
      operation(request.scope.sessionId, 'memory_write', `Memory write: [${kind}] ${text}`),
      at,
    );
    request.signal.throwIfAborted();
    return editableRecord(fact, { createdAt: fact.createdAt, supportCount: 1 });
  }

  public async update(request: MemoryUpdateRequest): Promise<MemoryRecord | undefined> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    const at = new Date();
    const scope = scopeOf(request.scope);
    const factId = editableFactId(request.id);
    const current = await this.#store.liveFactById(scope, factId);
    if (current === undefined) return undefined;

    const kind = boundedText(request.kind, 'Memory fact kind', 64);
    const text = boundedText(request.text, 'Memory fact text', 4_000);
    const validFrom = timestamp(request.validFrom, at, 'validFrom');
    const vector = await this.#vectorFor(text, request.signal);
    const fact = await this.#store.replaceFact(
      scope,
      factId,
      { kind, text, validFrom },
      vector,
      operation(
        request.scope.sessionId,
        'memory_update',
        `Memory update ${request.id}:\nBefore: [${current.kind}] ${current.text}\n` +
          `After: [${kind}] ${text}`,
      ),
      at,
    );
    request.signal.throwIfAborted();
    return fact === undefined
      ? undefined
      : editableRecord(fact, {
          createdAt: fact.createdAt,
          replacedId: request.id,
          supportCount: 1,
        });
  }

  public async forget(request: MemoryForgetRequest): Promise<boolean> {
    request.signal.throwIfAborted();
    await this.#ready(request.signal);
    const at = new Date();
    const scope = scopeOf(request.scope);
    const factId = editableFactId(request.id);
    const current = await this.#store.liveFactById(scope, factId);
    if (current === undefined) return false;

    const validTo = timestamp(request.validTo, at, 'validTo');
    const forgotten = await this.#store.forgetFact(
      scope,
      factId,
      validTo,
      operation(
        request.scope.sessionId,
        'memory_forget',
        `Memory forget ${request.id}: [${current.kind}] ${current.text}`,
      ),
      at,
    );
    request.signal.throwIfAborted();
    return forgotten;
  }

  /**
   * Vectors only, by measure: a fused lexical index never won alone and cost 32% of
   * recall. Without one, an unreachable embedder means no recall — but the runner
   * already continues without memory when recall fails.
   */
  public async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    request.signal.throwIfAborted();
    const scope = scopeOf(request.scope);
    const nearest = await this.#nearest(scope, request);
    request.signal.throwIfAborted();
    if (nearest.length === 0) return Object.freeze({ memories: Object.freeze([]) });

    const facts = new Map(
      (
        await this.#store.factsByIds(
          scope,
          nearest.map(({ factId }) => factId),
        )
      ).map((fact) => [fact.factId, fact]),
    );

    let remaining = request.maxTokens * CHARACTERS_PER_TOKEN;
    const accessed: number[] = [];
    const memories = nearest.flatMap((hit): RecalledMemory[] => {
      const fact = facts.get(hit.factId);
      if (fact === undefined || remaining <= 0) return [];
      const text = render(fact);
      const bounded = text.slice(0, remaining);
      remaining -= bounded.length;
      accessed.push(fact.factId);
      return [
        Object.freeze({
          id: String(fact.factId),
          metadata: Object.freeze({
            accessCount: hit.accessCount,
            decayPenalty: hit.decayPenalty,
            distance: hit.distance,
            kind: fact.kind,
            ...(hit.lastAccessedAt === undefined ? {} : { lastAccessedAt: hit.lastAccessedAt }),
            since: fact.validFrom,
            supportCount: hit.supportCount,
            ...(bounded.length === text.length ? {} : { truncated: true }),
          }),
          text: bounded,
        }),
      ];
    });
    this.#rememberAccesses(scope, accessed, new Date());

    return Object.freeze({ memories: Object.freeze(memories) });
  }

  /** The episode is what must not be lost; deciding what it meant runs on the memory's own clock. */
  public async retain(request: MemoryRetainRequest): Promise<void> {
    if (request.messages.length === 0) return;
    const scope = scopeOf(request.scope);
    const transcript = request.messages
      .map(
        (message) =>
          `${message.role === 'assistant' ? 'Assistant' : speaker(message)}: ${message.text}`,
      )
      .join('\n');

    const episodeId = await this.#store.recordEpisode(scope, {
      completedAt: request.completedAt.toISOString(),
      runId: request.runId,
      sessionId: request.scope.sessionId,
      startedAt: request.startedAt.toISOString(),
      status: request.status,
      transcript,
      trigger: request.trigger,
    });
    if (episodeId === undefined) return;
    // Not a pass: a turn ending is when the next turn is most likely to begin.
    this.#consider();
  }

  /** Brings the vector table in line with configuration. Called once, at startup. */
  public start(): Promise<void> {
    this.#started ??= this.#open();
    return this.#started;
  }

  async #open(): Promise<void> {
    const unchanged = await this.#store.openVectors(this.#identity());
    if (!unchanged) {
      this.#logger?.warn(
        { model: this.#embedding.reference.model, provider: this.#embedding.reference.provider },
        'Embedding model changed; stored vectors were discarded and will be rebuilt.',
      );
      this.#backfilling = true;
    }
    // At startup, so the first conversation does not pay for it and an unreachable
    // model is a warning rather than a surprise mid-recall.
    await this.#relevanceFloor(this.#lifetime.signal);
    // Unref'd so waiting for quiet never keeps the process from exiting.
    this.#tick = setInterval(() => {
      this.#consider();
    }, DREAM_TICK_MS);
    this.#tick.unref();
    this.#consider();
  }

  #available(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#stopped()) throw new Error('This memory instance has been disposed.');
  }

  #assertInspectionQuery(request: MemoryInspectionQuery): void {
    this.#available(request.signal);
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new RangeError('Memory inspection limit must be an integer between 1 and 100.');
    }
    if (!Number.isInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000) {
      throw new RangeError('Memory inspection offset must be an integer between 0 and 1000000.');
    }
  }

  async #ready(signal: AbortSignal): Promise<void> {
    this.#available(signal);
    await this.start();
    this.#available(signal);
  }

  /** What the stored vectors belong to, and what a calibration is keyed by. */
  #identity(): VectorIdentity {
    return {
      dimensions: this.#embedding.config().dimensions,
      model: this.#embedding.reference.model,
      provider: this.#embedding.reference.provider,
    };
  }

  /**
   * Pinned floor wins; otherwise measured per model and cached. On failure the
   * whole scale is returned — the floor is a saving, not a correctness requirement,
   * and a guessed bound could drop facts that do answer.
   */
  async #relevanceFloor(signal: AbortSignal): Promise<number> {
    if (this.#maxDistance !== undefined) return this.#maxDistance;
    if (this.#calibrated !== undefined) return this.#calibrated;

    const identity = this.#identity();
    try {
      const stored = await this.#store.calibratedFloor(identity);
      if (stored !== undefined) {
        this.#calibrated = stored.floor;
        return stored.floor;
      }

      const floor = await calibrateFloor(this.#embedding, signal);
      await this.#store.saveCalibratedFloor(identity, {
        calibratedAt: new Date().toISOString(),
        floor,
        pairs: (PROBES.length * (PROBES.length - 1)) / 2,
        quantile: NEAREST_QUANTILE,
      });
      this.#calibrated = floor;
      this.#logger?.info(
        { floor, model: identity.model, provider: identity.provider },
        'Measured the relevance floor of this embedding model.',
      );
      return floor;
    } catch (error) {
      if (signal.aborted) throw error;
      // Left uncached, so the next recall measures again rather than running
      // unfiltered for the life of the process.
      this.#logger?.warn(
        { err: error },
        'Could not measure the relevance floor; recalling without one.',
      );
      return NO_FLOOR;
    }
  }

  async #vectorFor(text: string, signal: AbortSignal): Promise<readonly number[]> {
    const embedded = await this.#embedding.embed([text], signal);
    signal.throwIfAborted();
    const vector = embedded.vectors[0];
    if (vector === undefined) throw new Error('The embedding model returned no vector.');
    return vector;
  }

  async #rank(
    scope: Scope,
    query: string,
    limit: number,
    signal: AbortSignal,
    at?: Date,
  ): Promise<readonly RankedFact[]> {
    const vector = await this.#vectorFor(query, signal);
    return this.#store.searchVector(scope, vector, limit, await this.#relevanceFloor(signal), at);
  }

  async #nearest(scope: Scope, request: MemoryRecallRequest): Promise<readonly RankedFact[]> {
    try {
      return await this.#rank(
        scope,
        request.query,
        this.#maxRecallFacts,
        request.signal,
        new Date(),
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      // Warned, not thrown: a turn answered from nothing beats one that does not happen.
      this.#logger?.warn({ err: error }, 'Could not reach the embedding model; recalled nothing.');
      return [];
    }
  }

  /** A method so narrowing across awaits cannot skip the check that stops a pass mid-drain. */
  #stopped(): boolean {
    return this.#lifetime.signal.aborted;
  }

  /** Whether someone is waiting on Nox, when anything can say. */
  #busy(): boolean {
    return this.#activity?.busy() ?? false;
  }

  /** Only when the ceiling did not start the pass: an overdue turn must not be deferred again. */
  #yielding(): boolean {
    return this.#busy() && !this.#overdue;
  }

  /** From the first quiet tick; under-counted, never over, so passes wait slightly too long. */
  #quietSeconds(now: number): number {
    if (this.#busy()) {
      this.#quietSince = undefined;
      return 0;
    }
    this.#quietSince ??= now;
    return (now - this.#quietSince) / 1_000;
  }

  /** Fire-and-forget: both callers are places where waiting on a read would delay a "no". */
  #consider(): void {
    if (this.#stopped()) return;
    this.#pass = this.#pass
      .then(async () => {
        if (this.#stopped()) return;
        // A write nobody waits on; holding it for quiet risks losing hints at shutdown.
        await this.#drainMaintenance();
        // Until backfill finishes, recall answers incompletely; it yields only to traffic.
        if (this.#backfilling && !this.#busy()) await this.#drainBackfill();
        if (await this.#shouldDream()) await this.#drainDream();
      })
      .catch(() => undefined);
  }

  /** Backlog and ceiling are read from the store so a restarted process inherits pending work. */
  async #shouldDream(): Promise<boolean> {
    this.#overdue = false;
    const backlog = await this.#store.pendingBacklog();
    const merging = this.#mergeDistance > 0 && backlog.unconsolidated > 0;
    if (backlog.count === 0 && !merging) return false;

    const now = Date.now();
    if (backlog.oldest !== undefined) {
      const waited = (now - Date.parse(backlog.oldest)) / 1_000;
      if (Number.isFinite(waited) && waited >= this.#dream.maxDelaySeconds) {
        this.#overdue = true;
        return true;
      }
    }
    if (backlog.count >= this.#dream.episodes) return true;
    // Consolidation has no deadline, so quiet alone must start it — never over a waiting user.
    return this.#quietSeconds(now) >= this.#dream.idleSeconds;
  }

  /** The part that costs nothing but a write, and so never waits for quiet. */
  async #drainMaintenance(): Promise<void> {
    if (this.#stopped()) return;
    try {
      await this.#flushAccesses();
    } catch (error) {
      if (this.#stopped()) return;
      this.#logger?.error({ err: error }, 'Memory could not persist its access batch.');
    }
  }

  /** Re-embedding what a model change discarded. Costs the embedder, not the extractor. */
  async #drainBackfill(): Promise<void> {
    if (this.#stopped()) return;
    try {
      await this.#backfill();
    } catch (error) {
      if (this.#stopped()) return;
      this.#logger?.error({ err: error }, 'Memory could not rebuild its discarded vectors.');
    }
  }

  /** The part that costs the extraction model, and so runs only when the policy allows it. */
  async #drainDream(): Promise<void> {
    if (this.#stopped()) return;
    try {
      await this.#extractPending();
    } catch (error) {
      if (this.#stopped()) return;
      this.#logger?.error({ err: error }, 'Memory could not work through its pending turns.');
    }
    // After extraction: the facts just written are the likeliest duplicates.
    await this.#drainConsolidation();
    // Last, and only when quiet: the one part that spends the model on work no turn asked for.
    if (!this.#busy()) await this.#drainContradictions();
  }

  /** The only place distance rather than recency decides what is compared: statements a month apart meet here. */
  async #drainContradictions(): Promise<void> {
    if (this.#stopped() || this.#contradictionDistance <= this.#mergeDistance) return;
    try {
      const pairs = await this.#store.contradictionCandidates({
        limit: CONTRADICTION_BATCH,
        maxDistance: this.#contradictionDistance,
        minDistance: this.#mergeDistance,
        scan: CONTRADICTION_SCAN,
      });

      for (const pair of pairs) {
        if (this.#stopped() || this.#busy()) return;
        const verdict = await judgeContradiction({
          model: this.#chat,
          pair,
          signal: this.#lifetime.signal,
        });

        const lower = Math.min(pair.earlier.factId, pair.later.factId);
        const higher = Math.max(pair.earlier.factId, pair.later.factId);
        await this.#store.resolveContradiction(
          { higher, lower },
          verdict.ended
            ? {
                factId: pair.earlier.factId,
                supersededBy: pair.later.factId,
                // The fact stops being true when its successor became true, not when Nox noticed.
                validTo: pair.later.validFrom,
              }
            : undefined,
          new Date(),
        );
        if (verdict.ended) {
          this.#logger?.debug(
            { ended: pair.earlier.factId, reason: verdict.reason, superseded: pair.later.factId },
            'Memory retired a belief a later one had ended.',
          );
        }
      }
    } catch (error) {
      if (this.#stopped()) return;
      this.#logger?.error({ err: error }, 'Memory could not resolve its contradictions.');
    }
  }

  /** No model cost, but it contends with extraction for the database — and a merge is never urgent. */
  async #drainConsolidation(): Promise<void> {
    if (this.#stopped() || this.#mergeDistance <= 0) return;
    try {
      const result = await this.#store.consolidateDuplicates(
        CONSOLIDATION_BATCH,
        this.#mergeDistance,
      );
      if (result.merged > 0) {
        this.#logger?.debug(
          { examined: result.examined, merged: result.merged },
          'Memory folded duplicate facts together.',
        );
      }
      // Re-entering through the policy stops the drain the moment someone starts talking.
      if (result.candidates === CONSOLIDATION_BATCH) this.#consider();
    } catch (error) {
      if (this.#stopped()) return;
      this.#logger?.error({ err: error }, 'Memory could not consolidate its duplicate facts.');
    }
  }

  #mergeAccess(access: FactAccess): void {
    const existing = this.#accesses.get(access.factId);
    this.#accesses.set(
      access.factId,
      existing === undefined
        ? access
        : {
            accessedAt:
              existing.accessedAt > access.accessedAt ? existing.accessedAt : access.accessedAt,
            count: existing.count + access.count,
            factId: access.factId,
            scope: access.scope,
          },
    );
    this.#accessTotal += access.count;
  }

  #rememberAccesses(scope: Scope, factIds: readonly number[], at: Date): void {
    if (this.#stopped() || factIds.length === 0) return;
    const accessedAt = at.toISOString();
    for (const factId of factIds) this.#mergeAccess({ accessedAt, count: 1, factId, scope });
    if (this.#accessTotal >= ACCESS_FLUSH_THRESHOLD) this.#consider();
  }

  /** Swaps first, so recalls arriving during the write belong to the next batch. */
  async #flushAccesses(): Promise<void> {
    if (this.#accesses.size === 0) return;
    const batch = this.#accesses;
    this.#accesses = new Map();
    this.#accessTotal = 0;
    try {
      await this.#store.recordAccesses([...batch.values()]);
    } catch (error) {
      // A transient failure must not erase a batch; re-merge so a later pass can retry it.
      for (const access of batch.values()) this.#mergeAccess(access);
      throw error;
    }
  }

  async #extractPending(): Promise<void> {
    const pending = await this.#store.pendingEpisodes(EXTRACTION_BATCH);
    for (const episode of pending) {
      if (this.#stopped()) return;
      // Between episodes: an in-flight call is paid for either way, and the run
      // starting is the signal to hand the machine back.
      if (this.#yielding()) return;
      const existing = await this.#beliefsFor(episode.scope, episode.transcript);
      const drafts = await extract({
        existing,
        model: this.#chat,
        occurredAt: new Date(episode.completedAt),
        signal: this.#lifetime.signal,
        transcript: episode.transcript,
      });

      if (drafts.length === 0) {
        await this.#store.markExtracted(episode.episodeId, new Date());
        continue;
      }

      const reinforcements = drafts.flatMap((draft): Reinforcement[] =>
        draft.reinforces === undefined
          ? []
          : [{ confidence: draft.confidence, factId: draft.reinforces }],
      );
      const novel = drafts.filter((draft) => draft.reinforces === undefined);
      const paired: { draft: DraftFact; vector: readonly number[] }[] = [];
      if (novel.length > 0) {
        const embedded = await this.#embedding.embed(
          novel.map((draft) => draft.text),
          this.#lifetime.signal,
        );
        for (const [index, draft] of novel.entries()) {
          const vector = embedded.vectors[index];
          if (vector !== undefined) paired.push({ draft, vector });
        }
      }
      await this.#store.saveExtraction(
        episode.episodeId,
        episode.scope,
        paired,
        reinforcements,
        new Date(),
      );
    }

    // Re-enter through the policy so a backlog drains while quiet and stops when traffic returns.
    if (pending.length === EXTRACTION_BATCH) this.#consider();
  }

  /** Recency alone would hide a still-live fact; semantic neighbours let it be superseded or reinforced. */
  async #beliefsFor(scope: Scope, transcript: string): Promise<readonly StoredFact[]> {
    const live = await this.#store.liveFacts(scope, BELIEF_WINDOW + 1);
    if (live.length <= BELIEF_WINDOW) return live;

    const recent = live.slice(0, BELIEF_WINDOW);
    try {
      const embedded = await this.#embedding.embed(
        [transcript.slice(0, BELIEF_QUERY_CHARACTERS)],
        this.#lifetime.signal,
      );
      const vector = embedded.vectors[0];
      if (vector === undefined) return recent;

      const nearest = await this.#store.searchVector(
        scope,
        vector,
        OLDER_BELIEF_CANDIDATES,
        // Consolidation wants every neighbour it can rank rather than only the
        // relevant ones: the point is to find the old fact a turn may supersede.
        NO_FLOOR,
      );
      const recentIds = new Set(recent.map((fact) => fact.factId));
      const olderIds = nearest.map((hit) => hit.factId).filter((factId) => !recentIds.has(factId));
      if (olderIds.length === 0) return recent;

      const byId = new Map(
        (await this.#store.factsByIds(scope, olderIds)).map((fact) => [fact.factId, fact]),
      );
      const older = olderIds.flatMap((factId): StoredFact[] => {
        const fact = byId.get(factId);
        return fact === undefined ? [] : [fact];
      });
      return [...older, ...recent].slice(0, BELIEF_WINDOW);
    } catch (error) {
      if (this.#stopped()) throw error;
      this.#logger?.warn(
        { err: error },
        'Could not search older beliefs; extracting against recent facts only.',
      );
      return recent;
    }
  }

  /** Re-embeds what a model change discarded, a bounded batch per pass. */
  async #backfill(): Promise<void> {
    const stale = await this.#store.unvectoredFacts(BACKFILL_BATCH);
    if (stale.length === 0) {
      this.#backfilling = false;
      return;
    }

    const embedded = await this.#embedding.embed(
      stale.map((fact) => fact.text),
      this.#lifetime.signal,
    );

    // Grouped by partition, the unit `vec0` searches within.
    const byScope = new Map<string, { scope: Scope; vectors: Vectored[] }>();
    for (const [index, fact] of stale.entries()) {
      const vector = embedded.vectors[index];
      if (vector === undefined) continue;
      const key = partitionKey(fact.scope);
      const bucket = byScope.get(key) ?? { scope: fact.scope, vectors: [] };
      bucket.vectors.push({ factId: fact.factId, vector });
      byScope.set(key, bucket);
    }
    for (const { scope, vectors } of byScope.values()) {
      await this.#store.restoreVectors(scope, vectors);
    }

    if (stale.length === BACKFILL_BATCH) this.#consider();
  }
}

/** A remembered line needs its speaker; the display name is presentation, never identity. */
function speaker(message: MemoryRetainRequest['messages'][number]): string {
  if (message.principal === undefined) return 'User';
  const subject = `${message.principal.issuer}:${message.principal.subject}`;
  return message.displayName === undefined
    ? `User (${subject})`
    : `User (${message.displayName} <${subject}>)`;
}

export { SemanticMemory };

export type { SemanticMemoryOptions };
