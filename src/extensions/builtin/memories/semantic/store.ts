import {
  type ExtensionStateTransaction,
  type ExtensionStorage,
  type MemoryEpisodeInspection,
  type MemoryFactInspection,
  type MemoryInspectionPage,
  type MemoryInspectionQuery,
  type MemoryScope,
  type MemoryScopeInspection,
  z,
} from '@nox/extension-api';

/** The security boundary, flattened into the columns every query filters on. */
interface Scope {
  readonly agentId: string;
  readonly issuer: string;
  readonly subject: string;
}

interface EpisodeRecord {
  readonly completedAt: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly status: string;
  readonly transcript: string;
  readonly trigger: string;
}

interface EditableFactDraft {
  readonly kind: string;
  readonly text: string;
  readonly validFrom: string;
}

interface FactOperation {
  readonly runId: string;
  readonly sessionId: string;
  readonly transcript: string;
  readonly trigger: 'memory_forget' | 'memory_update' | 'memory_write';
}

interface UnvectoredFact {
  readonly factId: number;
  readonly scope: Scope;
  readonly text: string;
}

/** What is waiting to be extracted, as the timer's cheap question. */
/** One always-present block, as the store keeps it. */
interface StoredBlock {
  readonly label: string;
  readonly updatedAt: string;
  readonly value: string;
}

/** Two live beliefs the same distance band says might disagree. */
interface FactPair {
  readonly distance: number;
  /** The one stated first, and so the one that may have been ended. */
  readonly earlier: StoredFact;
  readonly later: StoredFact;
  readonly scope: Scope;
}

interface ContradictionQuery {
  readonly limit: number;
  readonly maxDistance: number;
  readonly minDistance: number;
  /** How many recent live facts to look for candidates among. */
  readonly scan: number;
}

/** What one consolidation pass looked at and what it folded together. */
interface Consolidation {
  /** Facts pulled from the queue, including any still waiting for a vector. */
  readonly candidates: number;
  readonly examined: number;
  readonly merged: number;
}

interface Backlog {
  readonly count: number;
  /** When the longest-waiting unextracted turn finished. Absent when none wait. */
  readonly oldest?: string;
  /** Live facts consolidation has not compared to anything yet. */
  readonly unconsolidated: number;
}

interface PendingEpisode {
  readonly completedAt: string;
  readonly episodeId: number;
  readonly scope: Scope;
  readonly transcript: string;
}

/** One statement an extraction produced, before it has been given an identity. */
interface DraftFact {
  readonly confidence: number;
  /** Facts this one supersedes, by id, as the extractor identified them. */
  readonly invalidates: readonly number[];
  readonly kind: string;
  readonly reinforces?: number;
  readonly text: string;
  readonly validFrom: string;
}

interface Reinforcement {
  readonly confidence: number;
  readonly factId: number;
}

interface FactAccess {
  readonly accessedAt: string;
  readonly count: number;
  readonly factId: number;
  readonly scope: Scope;
}

/** One neighbour, with its vector distance and independent witnesses. */
interface RankedFact {
  readonly accessCount: number;
  readonly decayPenalty: number;
  readonly distance: number;
  readonly factId: number;
  readonly lastAccessedAt: string | undefined;
  readonly supportCount: number;
}

interface StoredFact {
  readonly createdAt: string;
  readonly factId: number;
  readonly kind: string;
  readonly text: string;
  readonly validFrom: string;
  readonly validTo: string | undefined;
}

/** What a vector belongs to. Vectors written under one model mean nothing under another. */
interface VectorIdentity {
  readonly dimensions: number;
  readonly model: string;
  readonly provider: string;
}

/**
 * A relevance floor measured against one embedding model, with its workings:
 * a floor with no record of how it was arrived at is a guess, and this one is
 * meant to be re-derivable rather than believed.
 */
interface FloorCalibration {
  readonly calibratedAt: string;
  readonly floor: number;
  readonly pairs: number;
  readonly quantile: number;
}

/**
 * How many candidates are fetched per fact wanted. Four, not configurable: it
 * exists only to absorb invalidated neighbours, which is an implementation
 * detail of how supersession is stored.
 */
const INVALIDATION_HEADROOM = 4;

/**
 * How many neighbours a consolidation candidate inspects. Small on purpose: a
 * duplicate is by definition the nearest thing in the space, so widening only
 * pays `vec0` to rank facts that were never going to be close enough to merge.
 */
const MERGE_NEIGHBOURS = 5;

/**
 * How many neighbours a contradiction scan inspects per fact. Wider than the
 * merge scan: a contradiction is not necessarily the nearest thing — "moved to
 * Lisbon" sits further from "lives in Madrid" than a dozen other statements do.
 */
const CONTRADICTION_NEIGHBOURS = 8;

/** Repetition may settle a close rank, but it must never overpower relevance. */
const MAX_SUPPORT_PROMOTION = 0.05;
const SUPPORT_PROMOTION = 0.02;

/** Staleness moves close ties; it never makes a semantically remote fact relevant. */
const DECAY_GRACE_DAYS = 90;
const DECAY_HALF_LIFE_DAYS = 180;
const DECAY_STEP = 0.02;
const MAX_DECAY_PENALTY = 0.08;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

const CALIBRATION_COLLECTION = 'relevance-floor';
const IDENTITY_COLLECTION = 'vector-identity';
const IDENTITY_KEY = 'current';
const VECTOR_TABLE = 'semantic_fact_vectors';

const identitySchema = z.object({
  dimensions: z.number().int().positive(),
  model: z.string(),
  provider: z.string(),
});

const calibrationSchema = z.object({
  calibratedAt: z.string(),
  floor: z.number().positive(),
  pairs: z.number().int().positive(),
  quantile: z.number().positive(),
});

const idRow = z.object({ id: z.number() });
const factRow = z.object({
  created_at: z.string(),
  fact_id: z.number(),
  kind: z.string(),
  text: z.string(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
});
const pendingRow = z.object({
  agent_id: z.string(),
  completed_at: z.string(),
  episode_id: z.number(),
  issuer: z.string(),
  subject: z.string(),
  transcript: z.string(),
});
const backlogRow = z.object({
  oldest: z.string().nullable(),
  pending: z.number().int().nonnegative(),
});
const unconsolidatedRow = z.object({ total: z.number().int().nonnegative() });
const nearestRow = z.object({ distance: z.number(), fact_id: z.number() });
const rankedRow = z.object({
  access_count: z.number().int().nonnegative(),
  confidence: z.number(),
  created_at: z.string(),
  fact_id: z.number(),
  last_accessed_at: z.string().nullable(),
  support_count: z.number().int().positive(),
});
const embeddingRow = z.object({ embedding: z.instanceof(Uint8Array) });
const mergeCandidateRow = z.object({
  agent_id: z.string(),
  created_at: z.string(),
  fact_id: z.number(),
  issuer: z.string(),
  kind: z.string(),
  subject: z.string(),
});
const blockRow = z.object({
  label: z.string(),
  updated_at: z.string(),
  value: z.string(),
});
const contradictionFactRow = z.object({
  agent_id: z.string(),
  created_at: z.string(),
  fact_id: z.number(),
  issuer: z.string(),
  kind: z.string(),
  subject: z.string(),
  text: z.string(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
});
const mergeNeighbourRow = z.object({
  access_count: z.number().int().nonnegative(),
  confidence: z.number(),
  created_at: z.string(),
  fact_id: z.number(),
  last_accessed_at: z.string().nullable(),
});
const factIdRow = z.object({ fact_id: z.number() });
const countRow = z.object({ total: z.number().int().nonnegative() });
const inspectionFactRow = z.object({
  access_count: z.number().int().nonnegative(),
  confidence: z.number(),
  created_at: z.string(),
  fact_id: z.number(),
  invalidated_at: z.string().nullable(),
  invalidated_by: z.number().nullable(),
  invalidated_episode_id: z.number().nullable(),
  kind: z.string(),
  last_accessed_at: z.string().nullable(),
  support_count: z.number().int().nonnegative(),
  text: z.string(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
});
const inspectionProvenanceRow = z.object({
  completed_at: z.string(),
  episode_id: z.number(),
  fact_id: z.number(),
  session_id: z.string(),
  trigger: z.string(),
});
const inspectionEpisodeRow = z.object({
  agent_id: z.string(),
  completed_at: z.string(),
  episode_id: z.number(),
  extracted_at: z.string().nullable(),
  issuer: z.string(),
  run_id: z.string(),
  session_id: z.string(),
  started_at: z.string(),
  status: z.string(),
  subject: z.string(),
  transcript: z.string(),
  trigger: z.string(),
});
const episodeFactRow = z.object({ episode_id: z.number(), fact_id: z.number() });
const factScopeRow = z.object({
  access_count: z.number().int().nonnegative(),
  agent_id: z.string(),
  fact_count: z.number().int().nonnegative(),
  issuer: z.string(),
  last_activity_at: z.string().nullable(),
  live_fact_count: z.number().int().nonnegative(),
  subject: z.string(),
});
const episodeScopeRow = z.object({
  agent_id: z.string(),
  episode_count: z.number().int().nonnegative(),
  issuer: z.string(),
  last_activity_at: z.string().nullable(),
  subject: z.string(),
});
const unvectoredRow = z.object({ 
  agent_id: z.string(),
  fact_id: z.number(),
  issuer: z.string(),
  subject: z.string(),
  text: z.string(),
});

function scopeOf(scope: MemoryScope): Scope {
  return {
    agentId: scope.agentId,
    issuer: scope.principal.issuer,
    subject: scope.principal.subject,
  };
}

/** The whole identity as one value, so comparing it cannot check two thirds of it. */
function ownerKey(agentId: string, issuer: string, subject: string): string {
  return `${agentId}\u0000${issuer}\u0000${subject}`;
}

function identityKey(identity: VectorIdentity): string {
  return [identity.provider, identity.model, String(identity.dimensions)]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function decayPenalty(belief: z.infer<typeof rankedRow>, at: Date | undefined): number {
  if (at === undefined) return 0;
  const anchor = Date.parse(belief.last_accessed_at ?? belief.created_at);
  const elapsed = at.getTime() - anchor;
  if (!Number.isFinite(anchor) || elapsed <= DECAY_GRACE_DAYS * MILLISECONDS_PER_DAY) return 0;

  const staleDays = elapsed / MILLISECONDS_PER_DAY - DECAY_GRACE_DAYS;
  const raw = Math.log2(1 + staleDays / DECAY_HALF_LIFE_DAYS) * DECAY_STEP;
  // Independent witnesses slow decay. Access does not accumulate a permanent
  // bonus: its timestamp resets age, avoiding a rich-get-richer retrieval loop.
  return Math.min(MAX_DECAY_PENALTY, raw / Math.sqrt(belief.support_count));
}

function toStoredFact(row: z.infer<typeof factRow>): StoredFact {
  return {
    createdAt: row.created_at,
    factId: row.fact_id,
    kind: row.kind,
    text: row.text,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
  };
}

/** Raw float32, which is both what `vec0` reads and what a BLOB column holds. */
function toBytes(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/**
 * Moves one fact's witnesses, weight and usage onto another, and retires it.
 * The duplicate is invalidated rather than deleted, pointing at the survivor
 * through the same `invalidated_by` edge a superseded fact uses — which is
 * what an audit needs to follow.
 */
function mergeFacts(
  transaction: ExtensionStateTransaction,
  survivor: number,
  duplicate: number,
  at: string,
): void {
  // Witnesses first, and by union: the same episode can support both rows when
  // one turn stated the thing twice, and the pair must not count it twice.
  transaction.run(
    'INSERT INTO semantic_fact_provenance (fact_id, episode_id) ' +
      'SELECT ?, episode_id FROM semantic_fact_provenance WHERE fact_id = ? ' +
      'ON CONFLICT DO NOTHING',
    [survivor, duplicate],
  );

  // Confidence combines the way an extractor's reinforcement does, because that
  // is what this is: two independent statements of one claim.
  transaction.run(
    'UPDATE semantic_facts SET ' +
      'confidence = MIN(1.0, 1.0 - ((1.0 - confidence) * (1.0 - ' +
      '(SELECT confidence FROM semantic_facts WHERE fact_id = ?)))), ' +
      'access_count = access_count + ' +
      '(SELECT access_count FROM semantic_facts WHERE fact_id = ?), ' +
      // Recency survives the merge: the pair was last useful whenever either of
      // them was, and decay reads that timestamp.
      "last_accessed_at = NULLIF(MAX(COALESCE(last_accessed_at, ''), " +
      "COALESCE((SELECT last_accessed_at FROM semantic_facts WHERE fact_id = ?), '')), '') " +
      'WHERE fact_id = ?',
    [duplicate, duplicate, duplicate, survivor],
  );

  transaction.run(
    'UPDATE semantic_facts SET invalidated_at = ?, invalidated_by = ?, consolidated_at = ? ' +
      'WHERE fact_id = ?',
    [at, survivor, at, duplicate],
  );

  // The vector goes, unlike a superseded fact's. A merged row is not a distinct
  // answer to anything: leaving it indexed would let one statement occupy two
  // of the handful of slots a recall has.
  transaction.run(`DELETE FROM ${VECTOR_TABLE} WHERE fact_id = ?`, [duplicate]);
}

function insertOperationEpisode(
  transaction: ExtensionStateTransaction,
  scope: Scope,
  operation: FactOperation,
  at: string,
): number {
  const inserted = transaction.one(
    'INSERT INTO semantic_episodes (' +
      'agent_id, issuer, subject, session_id, run_id, status, trigger, ' +
      'started_at, completed_at, transcript, extracted_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING episode_id AS id',
    [
      scope.agentId,
      scope.issuer,
      scope.subject,
      operation.sessionId,
      operation.runId,
      'completed',
      operation.trigger,
      at,
      at,
      operation.transcript,
      at,
    ],
    (row) => idRow.parse(row),
  );
  if (inserted === undefined) throw new Error('Could not record the memory operation episode.');
  return inserted.id;
}

function insertEditableFact(
  transaction: ExtensionStateTransaction,
  scope: Scope,
  episodeId: number,
  draft: EditableFactDraft,
  vector: readonly number[],
  at: string,
): StoredFact {
  const inserted = transaction.one(
    'INSERT INTO semantic_facts (' +
      'agent_id, issuer, subject, kind, text, valid_from, created_at, confidence) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING fact_id AS id',
    [scope.agentId, scope.issuer, scope.subject, draft.kind, draft.text, draft.validFrom, at, 1],
    (row) => idRow.parse(row),
  );
  if (inserted === undefined) throw new Error('Could not write the memory fact.');

  transaction.run(`INSERT INTO ${VECTOR_TABLE} (scope, fact_id, embedding) VALUES (?, ?, ?)`, [
    partitionKey(scope),
    inserted.id,
    toBytes(vector),
  ]);
  transaction.run('INSERT INTO semantic_fact_provenance (fact_id, episode_id) VALUES (?, ?)', [
    inserted.id,
    episodeId,
  ]);
  return {
    createdAt: at,
    factId: inserted.id,
    kind: draft.kind,
    text: draft.text,
    validFrom: draft.validFrom,
    validTo: undefined,
  };
}

/**
 * Everything this memory keeps, and the only place it writes SQL.
 *
 * The scope is a set of indexed columns rather than a prefix on a key, so it is
 * part of the query plan: one principal's facts are filtered out by the index
 * rather than by loading the corpus and discarding most of it.
 */
class SemanticStore {
  readonly #storage: ExtensionStorage;

  constructor(storage: ExtensionStorage) {
    this.#storage = storage;
  }

  /**
   * Brings the vector table into line with the configured embedding model.
   * Its width comes from configuration, not code, so this cannot be a migration.
   * On a model change the old vectors are numbers in a different space — they
   * still compare and rank, and are quietly about nothing — so they are dropped
   * and the facts become the backfill queue.
   */
  public async openVectors(identity: VectorIdentity): Promise<boolean> {
    return this.#storage.transact((transaction) => {
      const stored = transaction.get(IDENTITY_COLLECTION, IDENTITY_KEY, (value) => {
        const parsed = identitySchema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      });
      const unchanged = stored !== undefined && identityKey(stored) === identityKey(identity);

      if (!unchanged) transaction.run(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`, []);
      transaction.run(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(` +
          'scope TEXT PARTITION KEY, ' +
          'fact_id INTEGER PRIMARY KEY, ' +
          `embedding float[${String(identity.dimensions)}])`,
        [],
      );
      transaction.set(IDENTITY_COLLECTION, IDENTITY_KEY, identity);
      return unchanged;
    });
  }

  /**
   * The floor measured for one embedding model, if it has been measured. Keyed
   * by the whole identity, so switching models and back never pays twice — and
   * never filters one model's distances with another's geometry.
   */
  public calibratedFloor(identity: VectorIdentity): Promise<FloorCalibration | undefined> {
    return this.#storage.transact((transaction) =>
      transaction.get(CALIBRATION_COLLECTION, identityKey(identity), (value) => {
        const parsed = calibrationSchema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      }),
    );
  }

  public saveCalibratedFloor(
    identity: VectorIdentity,
    calibration: FloorCalibration,
  ): Promise<void> {
    return this.#storage.transact((transaction) => {
      transaction.set(CALIBRATION_COLLECTION, identityKey(identity), calibration);
    });
  }

  /**
   * Writes the turn and says whether it is new.
   *
   * Retention is drained after a run and may be retried, so the same run
   * arriving twice has to be the same episode rather than a second copy of the
   * conversation.
   */
  public recordEpisode(scope: Scope, record: EpisodeRecord): Promise<number | undefined> {
    return this.#storage.transact((transaction) => {
      const inserted = transaction.one(
        'INSERT INTO semantic_episodes (' +
          'agent_id, issuer, subject, session_id, run_id, status, trigger, ' +
          'started_at, completed_at, transcript) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (agent_id, issuer, subject, run_id) DO NOTHING ' +
          'RETURNING episode_id AS id',
        [
          scope.agentId,
          scope.issuer,
          scope.subject,
          record.sessionId,
          record.runId,
          record.status,
          record.trigger,
          record.startedAt,
          record.completedAt,
          record.transcript,
        ],
        (row) => idRow.parse(row),
      );
      return inserted?.id;
    });
  }

  /** Writes one explicit fact and its already-extracted operation provenance atomically. */
  public writeFact(
    scope: Scope,
    draft: EditableFactDraft,
    vector: readonly number[],
    operation: FactOperation,
    at: Date,
  ): Promise<StoredFact> {
    const now = at.toISOString();
    return this.#storage.transact((transaction) => {
      const episodeId = insertOperationEpisode(transaction, scope, operation, now);
      return insertEditableFact(transaction, scope, episodeId, draft, vector, now);
    });
  }

  /** Replaces a still-live fact inside the same scope, preserving both versions. */
  public replaceFact(
    scope: Scope,
    factId: number,
    draft: EditableFactDraft,
    vector: readonly number[],
    operation: FactOperation,
    at: Date,
  ): Promise<StoredFact | undefined> {
    const now = at.toISOString();
    return this.#storage.transact((transaction) => {
      const current = transaction.one(
        'SELECT fact_id, kind, text, valid_from, valid_to, created_at FROM semantic_facts ' +
          'WHERE fact_id = ? AND agent_id = ? AND issuer = ? AND subject = ? ' +
          'AND invalidated_at IS NULL',
        [factId, scope.agentId, scope.issuer, scope.subject],
        (row) => factRow.parse(row),
      );
      if (current === undefined) return undefined;

      const episodeId = insertOperationEpisode(transaction, scope, operation, now);
      const replacement = insertEditableFact(transaction, scope, episodeId, draft, vector, now);
      const changed = transaction.run(
        'UPDATE semantic_facts SET invalidated_at = ?, invalidated_by = ?, ' +
          'invalidated_episode_id = ?, valid_to = COALESCE(valid_to, ?) ' +
          'WHERE fact_id = ? AND agent_id = ? AND issuer = ? AND subject = ? ' +
          'AND invalidated_at IS NULL',
        [
          now,
          replacement.factId,
          episodeId,
          draft.validFrom,
          factId,
          scope.agentId,
          scope.issuer,
          scope.subject,
        ],
      );
      if (changed !== 1) throw new Error('The memory fact changed while it was being replaced.');
      return replacement;
    });
  }

  /** Logically retires a fact; history remains connected to the operation episode. */
  public forgetFact(
    scope: Scope,
    factId: number,
    validTo: string,
    operation: FactOperation,
    at: Date,
  ): Promise<boolean> {
    const now = at.toISOString();
    return this.#storage.transact((transaction) => {
      const current = transaction.one(
        'SELECT fact_id FROM semantic_facts WHERE fact_id = ? ' +
          'AND agent_id = ? AND issuer = ? AND subject = ? AND invalidated_at IS NULL',
        [factId, scope.agentId, scope.issuer, scope.subject],
        (row) => factIdRow.parse(row),
      );
      if (current === undefined) return false;

      const episodeId = insertOperationEpisode(transaction, scope, operation, now);
      return (
        transaction.run(
          'UPDATE semantic_facts SET invalidated_at = ?, invalidated_episode_id = ?, ' +
            'valid_to = COALESCE(valid_to, ?) WHERE fact_id = ? ' +
            'AND agent_id = ? AND issuer = ? AND subject = ? AND invalidated_at IS NULL',
          [now, episodeId, validTo, factId, scope.agentId, scope.issuer, scope.subject],
        ) === 1
      );
    });
  }

  /** The unextracted tail, oldest first, so a backlog is worked in order. */
  /**
   * The stored values for a set of declared block labels. Only what has been
   * written: a label the agent never filled comes back absent rather than
   * empty, so the caller can tell "never recorded" from "deliberately blanked".
   */
  public readBlocks(scope: Scope, labels: readonly string[]): Promise<readonly StoredBlock[]> {
    if (labels.length === 0) return Promise.resolve([]);
    return this.#storage.transact((transaction) =>
      transaction
        .all(
          'SELECT label, value, updated_at FROM semantic_blocks ' +
            'WHERE agent_id = ? AND issuer = ? AND subject = ? ' +
            `AND label IN (${labels.map(() => '?').join(', ')})`,
          [scope.agentId, scope.issuer, scope.subject, ...labels],
          (row) => blockRow.parse(row),
        )
        .map((row) => ({ label: row.label, updatedAt: row.updated_at, value: row.value })),
    );
  }

  /** Overwrites one block in place. A block has no history; it has a value. */
  public writeBlock(scope: Scope, label: string, value: string, at: Date): Promise<StoredBlock> {
    const updatedAt = at.toISOString();
    return this.#storage.transact((transaction) => {
      transaction.run(
        'INSERT INTO semantic_blocks (agent_id, issuer, subject, label, value, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (agent_id, issuer, subject, label) ' +
          'DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [scope.agentId, scope.issuer, scope.subject, label, value, updatedAt],
      );
      return { label, updatedAt, value };
    });
  }

  /**
   * Pairs of live beliefs close enough to be about one thing, far enough apart
   * to be saying different things about it. The band is the whole idea: below
   * it the pair is a restatement consolidation already folded; above it they
   * are simply different subjects. Only the middle case needs the model, and
   * pairs already put to it are excluded whatever the answer was — "no
   * contradiction" is the common verdict and expensive to rediscover.
   */
  public contradictionCandidates(request: ContradictionQuery): Promise<readonly FactPair[]> {
    return this.#storage.transact((transaction) => {
      const recent = transaction.all(
        'SELECT fact_id, agent_id, issuer, subject, kind, text, valid_from, valid_to, created_at ' +
          'FROM semantic_facts WHERE invalidated_at IS NULL ' +
          'ORDER BY created_at DESC LIMIT ?',
        [request.scan],
        (row) => contradictionFactRow.parse(row),
      );

      const pairs: FactPair[] = [];
      const seen = new Set<string>();
      for (const fact of recent) {
        if (pairs.length >= request.limit) break;
        const scope = {
          agentId: fact.agent_id,
          issuer: fact.issuer,
          subject: fact.subject,
        };
        const embedding = transaction.one(
          `SELECT embedding FROM ${VECTOR_TABLE} WHERE fact_id = ?`,
          [fact.fact_id],
          (row) => embeddingRow.parse(row),
        );
        if (embedding === undefined) continue;

        const neighbours = transaction
          .all(
            `SELECT fact_id, distance FROM ${VECTOR_TABLE} ` +
              'WHERE scope = ? AND embedding MATCH ? AND k = ? ORDER BY distance',
            [partitionKey(scope), embedding.embedding, CONTRADICTION_NEIGHBOURS],
            (row) => nearestRow.parse(row),
          )
          .filter(
            (row) =>
              row.fact_id !== fact.fact_id &&
              row.distance > request.minDistance &&
              row.distance <= request.maxDistance,
          );

        for (const neighbour of neighbours) {
          if (pairs.length >= request.limit) break;
          const lower = Math.min(fact.fact_id, neighbour.fact_id);
          const higher = Math.max(fact.fact_id, neighbour.fact_id);
          const key = `${String(lower)}:${String(higher)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const asked = transaction.one(
            'SELECT lower_fact_id AS fact_id FROM semantic_fact_contradictions ' +
              'WHERE lower_fact_id = ? AND higher_fact_id = ?',
            [lower, higher],
            (row) => factIdRow.parse(row),
          );
          if (asked !== undefined) continue;

          const other = transaction.one(
            'SELECT fact_id, agent_id, issuer, subject, kind, text, valid_from, valid_to, created_at ' +
              'FROM semantic_facts WHERE fact_id = ? AND invalidated_at IS NULL AND kind = ? ' +
              'AND agent_id = ? AND issuer = ? AND subject = ?',
            [neighbour.fact_id, fact.kind, scope.agentId, scope.issuer, scope.subject],
            (row) => contradictionFactRow.parse(row),
          );
          if (other === undefined) continue;

          // Ordered oldest first, so the model is shown the claim that came
          // first as the one that might have ended.
          const earlier = fact.created_at <= other.created_at ? fact : other;
          const later = earlier === fact ? other : fact;
          pairs.push({
            distance: neighbour.distance,
            earlier: toStoredFact(earlier),
            later: toStoredFact(later),
            scope,
          });
        }
      }
      return pairs;
    });
  }

  /**
   * Records what the model said about one pair, and acts on it. The verdict is
   * written whether or not anything ended, so the pair is not paid for twice;
   * an ended fact is invalidated through the same edge the extractor uses, so a
   * supersession found later reads exactly like one found in the turn.
   */
  public resolveContradiction(
    pair: { lower: number; higher: number },
    ended: undefined | { factId: number; supersededBy: number; validTo: string },
    at: Date,
  ): Promise<void> {
    const now = at.toISOString();
    return this.#storage.transact((transaction) => {
      transaction.run(
        'INSERT INTO semantic_fact_contradictions ' +
          '(lower_fact_id, higher_fact_id, checked_at, ended_fact_id) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT DO NOTHING',
        [pair.lower, pair.higher, now, ended?.factId ?? null],
      );
      if (ended === undefined) return;

      // Scoped and still-live in SQL, so a pass that raced an edit or another
      // invalidation retires nothing a second time.
      transaction.run(
        'UPDATE semantic_facts SET invalidated_at = ?, invalidated_by = ?, valid_to = ? ' +
          'WHERE fact_id = ? AND invalidated_at IS NULL',
        [now, ended.supersededBy, ended.validTo, ended.factId],
      );
    });
  }

  /**
   * Folds facts that say the same thing into one. The store only ever grew:
   * the same statement said twice a month apart lands as two rows, and two rows
   * split the support the ranking promotes on — a repeated fact can rank
   * *below* one stated once, the opposite of what promotion is for. The earlier
   * statement survives and the later retires pointing at it, because the pair's
   * `valid_from` belongs to when it first became true; nothing is deleted, and
   * the duplicate's witnesses move to the survivor.
   */
  public consolidateDuplicates(limit: number, maxDistance: number): Promise<Consolidation> {
    return this.#storage.transact((transaction) => {
      const candidates = transaction.all(
        'SELECT fact_id, agent_id, issuer, subject, kind, created_at FROM semantic_facts ' +
          'WHERE consolidated_at IS NULL AND invalidated_at IS NULL ' +
          'ORDER BY created_at LIMIT ?',
        [limit],
        (row) => mergeCandidateRow.parse(row),
      );

      const at = new Date().toISOString();
      let merged = 0;
      let examined = 0;

      for (const candidate of candidates) {
        const scope = {
          agentId: candidate.agent_id,
          issuer: candidate.issuer,
          subject: candidate.subject,
        };
        const embedding = transaction.one(
          `SELECT embedding FROM ${VECTOR_TABLE} WHERE fact_id = ?`,
          [candidate.fact_id],
          (row) => embeddingRow.parse(row),
        );
      // Left unconsolidated rather than skipped: a fact whose vector a model
      // change discarded has not been compared to anything yet; marking it now
      // would exempt it from consolidation forever.
      if (embedding === undefined) continue;
        examined += 1;

        const nearest = transaction
          .all(
            `SELECT fact_id, distance FROM ${VECTOR_TABLE} ` +
              'WHERE scope = ? AND embedding MATCH ? AND k = ? ORDER BY distance',
            [partitionKey(scope), embedding.embedding, MERGE_NEIGHBOURS],
            (row) => nearestRow.parse(row),
          )
          .filter((row) => row.fact_id !== candidate.fact_id && row.distance <= maxDistance);

        // Same kind only. The extractor drew the line between a preference and a
        // passing state deliberately, and two statements that differ in which
        // one they are do not say the same thing however close their wording.
        const twin =
          nearest.length === 0
            ? undefined
            : transaction.one(
                'SELECT fact_id, confidence, created_at, access_count, last_accessed_at ' +
                  'FROM semantic_facts WHERE fact_id IN ' +
                  `(${nearest.map(() => '?').join(', ')}) ` +
                  'AND invalidated_at IS NULL AND kind = ? ' +
                  'AND agent_id = ? AND issuer = ? AND subject = ? ' +
                  'ORDER BY created_at, fact_id LIMIT 1',
                [
                  ...nearest.map((row) => row.fact_id),
                  candidate.kind,
                  scope.agentId,
                  scope.issuer,
                  scope.subject,
                ],
                (row) => mergeNeighbourRow.parse(row),
              );

        if (twin !== undefined) {
          const candidateFirst =
            candidate.created_at < twin.created_at ||
            (candidate.created_at === twin.created_at && candidate.fact_id < twin.fact_id);
          const survivor = candidateFirst ? candidate.fact_id : twin.fact_id;
          const duplicate = candidateFirst ? twin.fact_id : candidate.fact_id;
          mergeFacts(transaction, survivor, duplicate, at);
          merged += 1;
          // The survivor is examined again on a later pass: absorbing a witness
          // does not change where it sits, but a third statement of the same
          // thing has to find it still eligible.
          if (!candidateFirst) continue;
        }

        transaction.run('UPDATE semantic_facts SET consolidated_at = ? WHERE fact_id = ?', [
          at,
          candidate.fact_id,
        ]);
      }

      return { candidates: candidates.length, examined, merged };
    });
  }

  /**
   * How much is waiting to be extracted, and how long the oldest has waited.
   * Counted, not fetched: the caller deciding whether to spend the extraction
   * model must not pay a transcript read to find out — the answer is almost
   * always "nothing, keep sleeping".
   */
  public pendingBacklog(): Promise<Backlog> {
    return this.#storage.transact((transaction) => {
      const row = transaction.one(
        'SELECT COUNT(*) AS pending, MIN(completed_at) AS oldest ' +
          'FROM semantic_episodes WHERE extracted_at IS NULL',
        [],
        (value) => backlogRow.parse(value),
      );
      // Counted in the same transaction, because the pass that decides whether
      // to wake also has to know whether there is anything but turns to do.
      const unconsolidated =
        transaction.one(
          'SELECT COUNT(*) AS total FROM semantic_facts ' +
            'WHERE consolidated_at IS NULL AND invalidated_at IS NULL',
          [],
          (value) => unconsolidatedRow.parse(value),
        )?.total ?? 0;
      if (row === undefined) return { count: 0, unconsolidated };
      return row.oldest === null
        ? { count: row.pending, unconsolidated }
        : { count: row.pending, oldest: row.oldest, unconsolidated };
    });
  }

  public pendingEpisodes(limit: number): Promise<readonly PendingEpisode[]> {
    return this.#storage.transact((transaction) =>
      transaction
        .all(
          'SELECT episode_id, agent_id, issuer, subject, completed_at, transcript ' +
            'FROM semantic_episodes ' +
            'WHERE extracted_at IS NULL ORDER BY completed_at LIMIT ?',
          [limit],
          (row) => pendingRow.parse(row),
        )
        .map((row) => ({
          completedAt: row.completed_at,
          episodeId: row.episode_id,
          scope: { agentId: row.agent_id, issuer: row.issuer, subject: row.subject },
          transcript: row.transcript,
        })),
    );
  }

  /**
   * Records what one episode taught, and what it ended.
   *
   * One transaction for the facts, their text index, their vectors, their
   * provenance and the invalidation of what they replaced — plus the mark on
   * the episode itself. A partial write here is a store that disagrees with its
   * own index, which nothing downstream can detect and no read can repair.
   */
  public saveExtraction(
    episodeId: number,
    scope: Scope,
    facts: readonly { draft: DraftFact; vector: readonly number[] }[],
    reinforcements: readonly Reinforcement[],
    at: Date,
  ): Promise<readonly number[]> {
    const now = at.toISOString();
    const partition = partitionKey(scope);

    return this.#storage.transact((transaction) => {
      const written: number[] = [];
      for (const { draft, vector } of facts) {
        const inserted = transaction.one(
          'INSERT INTO semantic_facts (' +
            'agent_id, issuer, subject, kind, text, valid_from, created_at, confidence) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING fact_id AS id',
          [
            scope.agentId,
            scope.issuer,
            scope.subject,
            draft.kind,
            draft.text,
            draft.validFrom,
            now,
            draft.confidence,
          ],
          (row) => idRow.parse(row),
        );
        if (inserted === undefined) continue;

        transaction.run(
          `INSERT INTO ${VECTOR_TABLE} (scope, fact_id, embedding) VALUES (?, ?, ?)`,
          [partition, inserted.id, toBytes(vector)],
        );
        transaction.run(
          'INSERT INTO semantic_fact_provenance (fact_id, episode_id) VALUES (?, ?) ' +
            'ON CONFLICT DO NOTHING',
          [inserted.id, episodeId],
        );

        for (const superseded of draft.invalidates) {
          // Scope is in the predicate, not assumed from the extractor: an id it
          // invented, or one belonging to somebody else, must retire nothing.
          transaction.run(
            'UPDATE semantic_facts SET invalidated_at = ?, invalidated_by = ?, ' +
              'valid_to = COALESCE(valid_to, ?) ' +
              'WHERE fact_id = ? AND invalidated_at IS NULL ' +
              'AND agent_id = ? AND issuer = ? AND subject = ?',
            [
              now,
              inserted.id,
              draft.validFrom,
              superseded,
              scope.agentId,
              scope.issuer,
              scope.subject,
            ],
          );
        }
        written.push(inserted.id);
      }

      for (const reinforcement of reinforcements) {
        // Both ends are scoped in SQL. A model-provided id must not attach an
        // episode to another principal even if a caller failed to filter it.
        const attached = transaction.one(
          'INSERT INTO semantic_fact_provenance (fact_id, episode_id) ' +
            'SELECT f.fact_id, e.episode_id FROM semantic_facts f, semantic_episodes e ' +
            'WHERE f.fact_id = ? AND e.episode_id = ? AND f.invalidated_at IS NULL ' +
            'AND f.agent_id = ? AND f.issuer = ? AND f.subject = ? ' +
            'AND e.agent_id = ? AND e.issuer = ? AND e.subject = ? ' +
            'ON CONFLICT DO NOTHING RETURNING fact_id',
          [
            reinforcement.factId,
            episodeId,
            scope.agentId,
            scope.issuer,
            scope.subject,
            scope.agentId,
            scope.issuer,
            scope.subject,
          ],
          (row) => factIdRow.parse(row),
        );
        if (attached === undefined) continue;

        // Independent support combines as cumulative probability rather than
        // addition, which preserves the [0, 1] confidence range.
        transaction.run(
          'UPDATE semantic_facts SET confidence = ' +
            'MIN(1.0, 1.0 - ((1.0 - confidence) * (1.0 - ?))) WHERE fact_id = ?',
          [reinforcement.confidence, reinforcement.factId],
        );
      }

      transaction.run('UPDATE semantic_episodes SET extracted_at = ? WHERE episode_id = ?', [
        now,
        episodeId,
      ]);
      return written;
    });
  }

  /**
   * Persists aggregated successful recalls.
   *
   * The caller has already collapsed repeated hits; one update per distinct fact
   * here keeps the transaction bounded by useful memories rather than by turns.
   * Scope remains in every predicate even though fact ids are global, because a
   * future caller must not be able to turn an id it guessed into another person's
   * usage history.
   */
  public recordAccesses(accesses: readonly FactAccess[]): Promise<void> {
    if (accesses.length === 0) return Promise.resolve();
    return this.#storage.transact((transaction) => {
      for (const access of accesses) {
        transaction.run(
          'UPDATE semantic_facts SET access_count = access_count + ?, ' +
            'last_accessed_at = CASE ' +
            'WHEN last_accessed_at IS NULL OR last_accessed_at < ? THEN ? ' +
            'ELSE last_accessed_at END ' +
            'WHERE fact_id = ? AND agent_id = ? AND issuer = ? AND subject = ?',
          [
            access.count,
            access.accessedAt,
            access.accessedAt,
            access.factId,
            access.scope.agentId,
            access.scope.issuer,
            access.scope.subject,
          ],
        );
      }
    });
  }

  /** Marks an episode done without facts, so a quiet turn leaves the queue. */
  public markExtracted(episodeId: number, at: Date): Promise<void> {
    return this.#storage.transact((transaction) => {
      transaction.run('UPDATE semantic_episodes SET extracted_at = ? WHERE episode_id = ?', [
        at.toISOString(),
        episodeId,
      ]);
    });
  }

  /**
   * Facts whose vectors a model change discarded, oldest first.
   *
   * The scope comes back with each row rather than being looked up per fact:
   * the vectors are written into a partition, and a query per fact to find out
   * which one is a round trip for something the same row already knows.
   */
  public unvectoredFacts(limit: number): Promise<readonly UnvectoredFact[]> {
    return this.#storage.transact((transaction) =>
      transaction
        .all(
          'SELECT f.fact_id, f.text, f.agent_id, f.issuer, f.subject FROM semantic_facts f ' +
            `LEFT JOIN ${VECTOR_TABLE} v ON v.fact_id = f.fact_id ` +
            'WHERE v.fact_id IS NULL AND f.invalidated_at IS NULL ' +
            'ORDER BY f.created_at LIMIT ?',
          [limit],
          (row) => unvectoredRow.parse(row),
        )
        .map((row) => ({
          factId: row.fact_id,
          scope: { agentId: row.agent_id, issuer: row.issuer, subject: row.subject },
          text: row.text,
        })),
    );
  }

  public restoreVectors(
    scope: Scope,
    vectors: readonly { factId: number; vector: readonly number[] }[],
  ): Promise<void> {
    const partition = partitionKey(scope);
    return this.#storage.transact((transaction) => {
      for (const { factId, vector } of vectors) {
        transaction.run(
          `INSERT INTO ${VECTOR_TABLE} (scope, fact_id, embedding) VALUES (?, ?, ?)`,
          [partition, factId, toBytes(vector)],
        );
      }
    });
  }

  /**
   * What is currently believed about one principal, newest first.
   *
   * This is what the extractor is shown so it can say which statements a turn
   * ended. Without it every contradiction becomes a second fact, and the store
   * grows two answers to the same question with no way to tell which is live.
   */
  public liveFacts(scope: Scope, limit: number): Promise<readonly StoredFact[]> {
    return this.#storage.transact((transaction) =>
      transaction
        .all(
          'SELECT fact_id, kind, text, valid_from, valid_to, created_at FROM semantic_facts ' +
            'WHERE agent_id = ? AND issuer = ? AND subject = ? AND invalidated_at IS NULL ' +
            'ORDER BY created_at DESC LIMIT ?',
          [scope.agentId, scope.issuer, scope.subject, limit],
          (row) => factRow.parse(row),
        )
        .map((row) => toStoredFact(row)),
    );
  }

  /**
   * The nearest live facts inside one partition.
   *
   * The scope is the partition key, so another principal's identical vector is
   * not ranked lower — it is never a candidate.
   *
   * More neighbours are asked for than are wanted, because `vec0` applies its
   * `k` before anything can say which of them are still believed. A principal
   * whose recent history is mostly corrections would otherwise get a short
   * answer built from a full one.
   *
   * `maxDistance` is what keeps a question nobody stored an answer to from
   * being handed five of them anyway. Nearest is not the same as near.
   */
  public searchVector(
    scope: Scope,
    vector: readonly number[],
    limit: number,
    maxDistance: number,
    at?: Date,
  ): Promise<readonly RankedFact[]> {
    return this.#storage.transact((transaction) => {
      const nearest = transaction
        .all(
          `SELECT fact_id, distance FROM ${VECTOR_TABLE} ` +
            'WHERE scope = ? AND embedding MATCH ? AND k = ? ORDER BY distance',
          [partitionKey(scope), toBytes(vector), limit * INVALIDATION_HEADROOM],
          (row) => nearestRow.parse(row),
        )
        .map((row) => ({ distance: row.distance, factId: row.fact_id }));
      if (nearest.length === 0) return [];

      // Invalidated facts keep their vectors, because a superseded statement is
      // still the answer to what used to be true. They are excluded here, where
      // the question is what is true now.
      const ranked = new Map(
        transaction
          .all(
            'SELECT f.fact_id, f.confidence, f.created_at, f.access_count, f.last_accessed_at, ' +
              'COUNT(p.episode_id) AS support_count ' +
              'FROM semantic_facts f JOIN semantic_fact_provenance p ON p.fact_id = f.fact_id ' +
              'WHERE f.invalidated_at IS NULL AND f.fact_id IN ' +
              `(${nearest.map(() => '?').join(', ')}) GROUP BY f.fact_id`,
            nearest.map(({ factId }) => factId),
            (row) => rankedRow.parse(row),
          )
          .map((row) => [row.fact_id, row] as const),
      );

      // Repetition breaks close semantic ties logarithmically. The cap prevents
      // any amount of repetition from turning an irrelevant fact into a match.
      return (
        nearest
          .flatMap((hit) => {
            const belief = ranked.get(hit.factId);
            if (belief === undefined) return [];
            const promotion = Math.min(
              MAX_SUPPORT_PROMOTION,
              Math.log2(belief.support_count) * belief.confidence * SUPPORT_PROMOTION,
            );
            const decay = decayPenalty(belief, at);
            return [
              {
                ...hit,
                accessCount: belief.access_count,
                decayPenalty: decay,
                lastAccessedAt: belief.last_accessed_at ?? undefined,
                score: hit.distance - promotion + decay,
                supportCount: belief.support_count,
              },
            ];
          })
          // Applied here rather than by the caller so nothing downstream has to
          // remember that a neighbour is not the same thing as a relevant one.
          .filter((hit) => hit.score <= maxDistance)
          .sort((left, right) => {
            const scoreDifference = left.score - right.score;
            return scoreDifference === 0 ? left.distance - right.distance : scoreDifference;
          })
          .slice(0, limit)
          .map(
            ({
              accessCount,
              decayPenalty: decay,
              distance,
              factId,
              lastAccessedAt,
              supportCount,
            }): RankedFact => ({
              accessCount,
              decayPenalty: decay,
              distance,
              factId,
              lastAccessedAt,
              supportCount,
            }),
          )
      );
    });
  }

  public inspectionScopes(): Promise<readonly MemoryScopeInspection[]> {
    return this.#storage.transact((transaction) => {
      const facts = transaction.all(
        'SELECT agent_id, issuer, subject, COUNT(*) AS fact_count, ' +
          'SUM(CASE WHEN invalidated_at IS NULL THEN 1 ELSE 0 END) AS live_fact_count, ' +
          'SUM(access_count) AS access_count, ' +
          'MAX(COALESCE(last_accessed_at, created_at)) AS last_activity_at ' +
          'FROM semantic_facts GROUP BY agent_id, issuer, subject',
        [],
        (row) => factScopeRow.parse(row),
      );
      const episodes = transaction.all(
        'SELECT agent_id, issuer, subject, COUNT(*) AS episode_count, ' +
          'MAX(completed_at) AS last_activity_at FROM semantic_episodes ' +
          'GROUP BY agent_id, issuer, subject',
        [],
        (row) => episodeScopeRow.parse(row),
      );
      const scopes = new Map<string, MemoryScopeInspection>();

      for (const row of facts) {
        scopes.set(ownerKey(row.agent_id, row.issuer, row.subject), {
          accessCount: row.access_count,
          agentId: row.agent_id,
          episodeCount: 0,
          factCount: row.fact_count,
          ...(row.last_activity_at === null ? {} : { lastActivityAt: row.last_activity_at }),
          liveFactCount: row.live_fact_count,
          principal: { issuer: row.issuer, subject: row.subject },
        });
      }
      for (const row of episodes) {
        const key = ownerKey(row.agent_id, row.issuer, row.subject);
        const current = scopes.get(key);
        scopes.set(key, {
          accessCount: current?.accessCount ?? 0,
          agentId: row.agent_id,
          episodeCount: row.episode_count,
          factCount: current?.factCount ?? 0,
          ...(row.last_activity_at === null && current?.lastActivityAt === undefined
            ? {}
            : {
                lastActivityAt:
                  current?.lastActivityAt !== undefined &&
                  (row.last_activity_at === null || current.lastActivityAt > row.last_activity_at)
                    ? current.lastActivityAt
                    : (row.last_activity_at ?? current?.lastActivityAt),
              }),
          liveFactCount: current?.liveFactCount ?? 0,
          principal: { issuer: row.issuer, subject: row.subject },
        });
      }

      return Object.freeze(
        [...scopes.values()].sort((left, right) => {
          const byAgent = left.agentId.localeCompare(right.agentId);
          if (byAgent !== 0) return byAgent;
          const byIssuer = left.principal.issuer.localeCompare(right.principal.issuer);
          return byIssuer === 0
            ? left.principal.subject.localeCompare(right.principal.subject)
            : byIssuer;
        }),
      );
    });
  }

  public inspectFacts(
    request: MemoryInspectionQuery,
  ): Promise<MemoryInspectionPage<MemoryFactInspection>> {
    const selected = request.scope;
    const where =
      selected === undefined
        ? ''
        : 'WHERE f.agent_id = ? AND f.issuer = ? AND f.subject = ? ';
    const parameters =
      selected === undefined
        ? []
        : [selected.agentId, selected.principal.issuer, selected.principal.subject];

    return this.#storage.transact((transaction) => {
      const total = transaction.one(
        'SELECT COUNT(*) AS total FROM semantic_facts f ' + where,
        parameters,
        (row) => countRow.parse(row),
      )?.total;
      const rows = transaction.all(
        'SELECT f.fact_id, f.kind, f.text, f.valid_from, f.valid_to, f.created_at, ' +
          'f.invalidated_at, f.invalidated_by, f.invalidated_episode_id, f.confidence, ' +
          'f.access_count, f.last_accessed_at, COUNT(p.episode_id) AS support_count ' +
          'FROM semantic_facts f LEFT JOIN semantic_fact_provenance p ON p.fact_id = f.fact_id ' +
          where +
          'GROUP BY f.fact_id ORDER BY f.created_at DESC, f.fact_id DESC LIMIT ? OFFSET ?',
        [...parameters, request.limit, request.offset],
        (row) => inspectionFactRow.parse(row),
      );
      const provenance =
        rows.length === 0
          ? []
          : transaction.all(
              'SELECT p.fact_id, e.episode_id, e.session_id, e.trigger, e.completed_at ' +
                'FROM semantic_fact_provenance p JOIN semantic_episodes e ' +
                'ON e.episode_id = p.episode_id ' +
                `WHERE p.fact_id IN (${rows.map(() => '?').join(', ')}) ` +
                'ORDER BY e.completed_at, e.episode_id',
              rows.map((row) => row.fact_id),
              (row) => inspectionProvenanceRow.parse(row),
            );
      const byFact = new Map<number, typeof provenance>();
      for (const entry of provenance) {
        byFact.set(entry.fact_id, [...(byFact.get(entry.fact_id) ?? []), entry]);
      }

      const entries = rows.map(
        (row): MemoryFactInspection => ({
          accessCount: row.access_count,
          confidence: row.confidence,
          createdAt: row.created_at,
          id: String(row.fact_id),
          ...(row.invalidated_at === null ? {} : { invalidatedAt: row.invalidated_at }),
          ...(row.invalidated_by === null ? {} : { invalidatedBy: String(row.invalidated_by) }),
          ...(row.invalidated_episode_id === null
            ? {}
            : { invalidatedEpisodeId: String(row.invalidated_episode_id) }),
          kind: row.kind,
          ...(row.last_accessed_at === null ? {} : { lastAccessedAt: row.last_accessed_at }),
          provenance: Object.freeze(
            (byFact.get(row.fact_id) ?? []).map((entry) => ({
              completedAt: entry.completed_at,
              episodeId: String(entry.episode_id),
              sessionId: entry.session_id,
              trigger: entry.trigger,
            })),
          ),
          supportCount: row.support_count,
          text: row.text,
          validFrom: row.valid_from,
          ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
        }),
      );
      return {
        entries: Object.freeze(entries),
        limit: request.limit,
        offset: request.offset,
        total: total ?? 0,
      };
    });
  }

  public inspectEpisodes(
    request: MemoryInspectionQuery,
  ): Promise<MemoryInspectionPage<MemoryEpisodeInspection>> {
    const selected = request.scope;
    const where =
      selected === undefined
        ? ''
        : 'WHERE e.agent_id = ? AND e.issuer = ? AND e.subject = ? ';
    const parameters =
      selected === undefined
        ? []
        : [selected.agentId, selected.principal.issuer, selected.principal.subject];

    return this.#storage.transact((transaction) => {
      const total = transaction.one(
        'SELECT COUNT(*) AS total FROM semantic_episodes e ' + where,
        parameters,
        (row) => countRow.parse(row),
      )?.total;
      const rows = transaction.all(
        'SELECT e.episode_id, e.agent_id, e.issuer, e.subject, e.session_id, e.run_id, ' +
          'e.status, e.trigger, e.started_at, e.completed_at, e.transcript, e.extracted_at ' +
          'FROM semantic_episodes e ' +
          where +
          'ORDER BY e.completed_at DESC, e.episode_id DESC LIMIT ? OFFSET ?',
        [...parameters, request.limit, request.offset],
        (row) => inspectionEpisodeRow.parse(row),
      );
      const facts =
        rows.length === 0
          ? []
          : transaction.all(
              'SELECT episode_id, fact_id FROM semantic_fact_provenance ' +
                `WHERE episode_id IN (${rows.map(() => '?').join(', ')}) ` +
                'ORDER BY fact_id',
              rows.map((row) => row.episode_id),
              (row) => episodeFactRow.parse(row),
            );
      const byEpisode = new Map<number, string[]>();
      for (const row of facts) {
        byEpisode.set(row.episode_id, [
          ...(byEpisode.get(row.episode_id) ?? []),
          String(row.fact_id),
        ]);
      }

      return {
        entries: Object.freeze(
          rows.map(
            (row): MemoryEpisodeInspection => ({
              completedAt: row.completed_at,
              episodeId: String(row.episode_id),
              ...(row.extracted_at === null ? {} : { extractedAt: row.extracted_at }),
              factIds: Object.freeze(byEpisode.get(row.episode_id) ?? []),
              runId: row.run_id,
              scope: {
                agentId: row.agent_id,
                principal: { issuer: row.issuer, subject: row.subject },
              },
              sessionId: row.session_id,
              startedAt: row.started_at,
              status: row.status,
              transcript: row.transcript,
              trigger: row.trigger,
            }),
          ),
        ),
        limit: request.limit,
        offset: request.offset,
        total: total ?? 0,
      };
    });
  }

  public liveFactById(scope: Scope, factId: number): Promise<StoredFact | undefined> {
    return this.#storage.transact((transaction) => {
      const row = transaction.one(
        'SELECT fact_id, kind, text, valid_from, valid_to, created_at FROM semantic_facts ' +
          'WHERE fact_id = ? AND agent_id = ? AND issuer = ? AND subject = ? ' +
          'AND invalidated_at IS NULL',
        [factId, scope.agentId, scope.issuer, scope.subject],
        (candidate) => factRow.parse(candidate),
      );
      return row === undefined ? undefined : toStoredFact(row);
    });
  }

  public factsByIds(scope: Scope, ids: readonly number[]): Promise<readonly StoredFact[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.#storage.transact((transaction) =>
      transaction
        .all(
          'SELECT fact_id, kind, text, valid_from, valid_to, created_at FROM semantic_facts ' +
            'WHERE agent_id = ? AND issuer = ? AND subject = ? ' +
            `AND fact_id IN (${ids.map(() => '?').join(', ')})`,
          [scope.agentId, scope.issuer, scope.subject, ...ids],
          (row) => factRow.parse(row),
        )
        .map((row) => toStoredFact(row)),
    );
  }
}

/**
 * The partition one principal's vectors live in.
 *
 * Encoded rather than joined with a separator, so an agent literally named
 * `a/b` cannot land in another principal's partition.
 */
function partitionKey(scope: Scope): string {
  return [scope.agentId, scope.issuer, scope.subject]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export { partitionKey, scopeOf, SemanticStore };

export type {
  Backlog,
  Consolidation,
  ContradictionQuery,
  DraftFact,
  EditableFactDraft,
  EpisodeRecord,
  FactAccess,
  FactOperation,
  FactPair,
  FloorCalibration,
  PendingEpisode,
  RankedFact,
  Reinforcement,
  Scope,
  StoredBlock,
  StoredFact,
  UnvectoredFact,
  VectorIdentity,
};
