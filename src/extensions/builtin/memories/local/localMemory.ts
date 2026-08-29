import {
  type ExtensionStorage,
  type Memory,
  type MemoryRecallResult,
  type MemoryScope,
  z,
} from '@nox/extension-api';

const localMemoryConfigSchema = z.object({
  maxEntriesPerScope: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .default(2_000)
    .meta({ nox: { help: 'ui.maxEntriesHelp', label: 'ui.maxEntries' } }),
  maxRecallItems: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(12)
    .meta({ nox: { help: 'ui.maxRecallItemsHelp', label: 'ui.maxRecallItems' } }),
  type: z.literal('local'),
});

// Attribution is optional throughout: rows written before it existed still
// parse, and the assistant's own turns are never handed a principal. What is
// absent renders exactly as it always did.
const storedMessageSchema = z.object({
  createdAt: z.string(),
  displayName: z.string().optional(),
  messageId: z.string(),
  principal: z.object({ issuer: z.string(), subject: z.string() }).optional(),
  role: z.enum(['assistant', 'user']),
  text: z.string(),
});
const storedTurnSchema = z.object({
  completedAt: z.string(),
  messages: z.array(storedMessageSchema),
  runId: z.string(),
  sessionId: z.string(),
  startedAt: z.string(),
  status: z.enum(['aborted', 'completed', 'failed', 'maxIterations']),
  trigger: z.enum(['cron', 'deferredResult', 'retry', 'steer', 'user']),
});

type LocalMemoryConfig = z.infer<typeof localMemoryConfigSchema>;
type LocalMemoryConfigInput = z.input<typeof localMemoryConfigSchema>;
type StoredMessage = z.infer<typeof storedMessageSchema>;
type StoredTurn = z.infer<typeof storedTurnSchema>;

interface RankedTurn {
  readonly score: number;
  readonly text: string;
  readonly turn: StoredTurn;
}

const CHARACTERS_PER_TOKEN = 3;
const COLLECTION_VERSION = 'turns-v1';
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const STOP_WORDS = new Set([
  'a',
  'al',
  'and',
  'are',
  'como',
  'con',
  'de',
  'del',
  'do',
  'el',
  'en',
  'es',
  'esta',
  'este',
  'for',
  'i',
  'in',
  'is',
  'la',
  'las',
  'lo',
  'los',
  'me',
  'mi',
  'my',
  'of',
  'para',
  'por',
  'que',
  'qué',
  'the',
  'to',
  'un',
  'una',
  'what',
  'y',
  'yo',
]);

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function tokens(text: string): string[] {
  return (normalize(text).match(TOKEN_PATTERN) ?? []).filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token),
  );
}

function collectionFor(scope: MemoryScope): string {
  return [
    COLLECTION_VERSION,
    encodeURIComponent(scope.agentId),
    encodeURIComponent(scope.principal.issuer),
    encodeURIComponent(scope.principal.subject),
  ].join(':');
}

function storedTurn(value: unknown): StoredTurn | undefined {
  const parsed = storedTurnSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Who a remembered line belongs to.
 *
 * A memory read back into a shared conversation is text with no speaker unless
 * one is written down. `User:` alone leaves the model to infer an owner, and in
 * a room with more than one person it infers wrong — so the principal that was
 * stored travels with the line, and the display name goes in front of it on the
 * same terms as everywhere else: presentation, never identity.
 */
function speakerOf(message: StoredMessage): string {
  if (message.role === 'assistant') return 'Assistant';
  if (message.principal === undefined) return 'User';
  const subject = `${message.principal.issuer}:${message.principal.subject}`;
  return message.displayName === undefined
    ? `User (${subject})`
    : `User (${message.displayName} <${subject}>)`;
}

function renderTurn(turn: StoredTurn): string {
  return [
    `Conversation memory from ${turn.completedAt}:`,
    ...turn.messages.map((message) => `${speakerOf(message)}: ${message.text}`),
  ].join('\n');
}

/** Small lexical BM25 pass over one already SQL-scoped principal corpus. */
function rankTurns(turns: readonly StoredTurn[], query: string): RankedTurn[] {
  const queryTerms = [...new Set(tokens(query))];
  if (queryTerms.length === 0 || turns.length === 0) return [];

  const documents = turns.map((turn) => {
    const text = renderTurn(turn);
    const documentTokens = tokens(text);
    const frequencies = new Map<string, number>();
    for (const token of documentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return { frequencies, length: documentTokens.length, text, turn };
  });
  const measuredAverageLength =
    documents.reduce((total, document) => total + document.length, 0) / documents.length;
  const averageLength = measuredAverageLength === 0 ? 1 : measuredAverageLength;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      documents.filter((document) => document.frequencies.has(term)).length,
    );
  }

  return documents
    .map((document): RankedTurn => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = document.frequencies.get(term) ?? 0;
        if (frequency === 0) continue;
        const containing = documentFrequency.get(term) ?? 0;
        const inverseFrequency = Math.log(
          1 + (documents.length - containing + 0.5) / (containing + 0.5),
        );
        const lengthNormalization = 1.2 * (0.25 + (0.75 * document.length) / averageLength);
        score += inverseFrequency * ((frequency * 2.2) / (frequency + lengthNormalization));
      }
      return { score, text: document.text, turn: document.turn };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore === 0 ? right.turn.completedAt.localeCompare(left.turn.completedAt) : byScore;
    });
}

/**
 * Nox's local long-term memory.
 *
 * Persistence is the extension's SQL-backed state. The collection key contains
 * both agent and principal identity, so retrieval cannot widen either scope.
 */
class LocalMemory implements Memory {
  public static readonly configSchema = localMemoryConfigSchema;

  readonly #maxEntriesPerScope: number;
  readonly #maxRecallItems: number;
  readonly #storage: ExtensionStorage;

  constructor(storage: ExtensionStorage, config: LocalMemoryConfig) {
    this.#storage = storage;
    this.#maxEntriesPerScope = config.maxEntriesPerScope;
    this.#maxRecallItems = config.maxRecallItems;
  }

  public async recall(request: Parameters<Memory['recall']>[0]): Promise<MemoryRecallResult> {
    request.signal.throwIfAborted();
    const turns = await this.#storage.transact((transaction) =>
      transaction
        .entries(collectionFor(request.scope), storedTurn)
        .flatMap(({ value }) => (value === undefined ? [] : [value])),
    );
    request.signal.throwIfAborted();

    let remainingCharacters = request.maxTokens * CHARACTERS_PER_TOKEN;
    const memories = rankTurns(turns, request.query)
      .slice(0, this.#maxRecallItems)
      .flatMap(({ score, text, turn }) => {
        if (remainingCharacters <= 0) return [];
        const bounded = text.slice(0, remainingCharacters);
        remainingCharacters -= bounded.length;
        return [
          Object.freeze({
            id: turn.runId,
            metadata: Object.freeze({
              completedAt: turn.completedAt,
              score,
              sessionId: turn.sessionId,
              status: turn.status,
              ...(bounded.length === text.length ? {} : { truncated: true }),
            }),
            text: bounded,
          }),
        ];
      });

    return Object.freeze({ memories: Object.freeze(memories) });
  }

  public async retain(request: Parameters<Memory['retain']>[0]): Promise<void> {
    if (request.messages.length === 0) return;
    const collection = collectionFor(request.scope);
    const turn: StoredTurn = {
      completedAt: request.completedAt.toISOString(),
      messages: request.messages.map((message) => ({
        createdAt: message.createdAt.toISOString(),
        ...(message.displayName === undefined ? {} : { displayName: message.displayName }),
        messageId: message.messageId,
        ...(message.principal === undefined
          ? {}
          : {
              principal: {
                issuer: message.principal.issuer,
                subject: message.principal.subject,
              },
            }),
        role: message.role,
        text: message.text,
      })),
      runId: request.runId,
      sessionId: request.scope.sessionId,
      startedAt: request.startedAt.toISOString(),
      status: request.status,
      trigger: request.trigger,
    };
    const key = `${turn.completedAt}:${turn.runId}`;

    await this.#storage.transact((transaction) => {
      transaction.set(collection, key, turn);
      const entries = transaction.entries(collection, () => undefined);
      for (const stale of entries.slice(0, -this.#maxEntriesPerScope)) {
        transaction.delete(collection, stale.key);
      }
    });
  }
}

export { LocalMemory, localMemoryConfigSchema, rankTurns };
export type { LocalMemoryConfig, LocalMemoryConfigInput };
