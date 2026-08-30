import { modelReferenceSchema, z } from '@nox/extension-api';

/**
 * The far end of the distance scale: every neighbour is inside it.
 *
 * Both the ceiling an operator may set and the value the memory falls back to
 * when it cannot ask the model where its unrelated pairs sit — losing the
 * filter costs context budget, where guessing a floor would cost recall.
 */
const NO_FLOOR = 2;

/**
 * What this memory needs configured, and nothing it can infer.
 *
 * Both models are named rather than defaulted. An embedding model is half the
 * identity of every vector this store keeps, and an extraction model decides
 * what is remembered at all; picking either on an operator's behalf would make
 * a silent choice that shows up months later as a corpus nobody meant to build.
 */
const semanticMemoryConfigSchema = z.object({
  /**
   * How far apart two beliefs may sit and still be put to the model as a
   * possible contradiction.
   *
   * The upper edge of a band whose lower edge is `mergeDistance`: nearer than
   * that they are a restatement and get merged instead, further than this they
   * are two different subjects and asking would be paying a model call to be
   * told so. Only statements about one thing land in between.
   *
   * This is the one part of consolidation that costs the extraction model, so
   * it is also the one worth turning off: 0 disables it, and the memory keeps
   * every other kind of consolidation. Raising it widens what gets asked about,
   * which costs calls rather than accuracy — the model still has to say yes.
   */
  contradictionDistance: z
    .number()
    .nonnegative()
    .max(NO_FLOOR)
    .default(0)
    .meta({ nox: { help: 'ui.contradictionDistanceHelp', label: 'ui.contradictionDistance' } }),
  /**
   * When the memory is allowed to spend the extraction model. Doing it as each
   * turn ends is the worst time available — it is exactly when the next turn is
   * most likely to start, and on a single-GPU installation the two contend for
   * the same weights. So retention stays free and the model is spent in
   * batches, on whichever of three conditions arrives first: enough turns piled
   * up to be worth a pass, the runtime quiet long enough that nobody is
   * waiting, or the oldest unextracted turn waited longer than anyone should
   * have to. The third is what keeps a machine that is never idle and never
   * busy enough from simply never remembering.
   */
  dream: z
    .object({
      /** Turns pending before a pass is worth running whether or not Nox is quiet. */
      episodes: z.number().int().positive().max(1_000).default(8),
      /**
       * How long the runtime must be quiet before a pass may start.
       *
       * Short enough that an ordinary pause between messages is usable, long
       * enough that it is not triggered by the gap while someone reads a reply.
       */
      idleSeconds: z.number().int().positive().max(86_400).default(90),
      /** The ceiling: without it a busy installation defers forever, invisibly. */
      maxDelaySeconds: z.number().int().positive().max(604_800).default(1_800),
    })
    .prefault({})
    .meta({ nox: { help: 'ui.dreamHelp', label: 'ui.dream' } }),
  embedding: modelReferenceSchema.meta({
    nox: { help: 'ui.embeddingHelp', label: 'ui.embedding' },
  }),
  extraction: modelReferenceSchema.meta({
    nox: { help: 'ui.extractionHelp', label: 'ui.extraction' },
  }),
  /**
   * How far a fact may be from the question and still be worth context.
   *
   * L2 distance on the scale `vec0` reports, which for normalized vectors runs
   * from 0 to 2. The floor exists because nearest is not the same as near:
   * without it, a question nobody stored an answer to is still handed the five
   * least-unrelated facts on file, every turn, out of the same budget a real
   * memory would have used.
   *
   * Left unset, and that is the point. The distance at which two texts stop
   * having anything to do with each other is a property of the embedding model,
   * not of this memory: the same number is a strict filter under one model and
   * no filter at all under another, so shipping one would be shipping whichever
   * model it was measured against. Unset, the memory measures its own model
   * once and keeps the answer beside the vectors it describes. Setting it here
   * pins the floor instead, for an operator who has swept it themselves with
   * `bun run eval:retrieval`; 2 turns the filter off.
   */
  maxDistance: z
    .number()
    .positive()
    .max(NO_FLOOR)
    .optional()
    .meta({ nox: { help: 'ui.maxDistanceHelp', label: 'ui.maxDistance' } }),
  /** How many facts a recall may place in context, before the token budget cuts it. */
  maxRecallFacts: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(20)
    .meta({ nox: { help: 'ui.maxRecallFactsHelp', label: 'ui.maxRecallFacts' } }),
  /**
   * How close two facts must be before one is folded into the other. Far
   * tighter than the relevance floor, and the asymmetry is deliberate: a recall
   * that returns something unrelated wastes a little context, while a merge
   * that folds two different statements together destroys one of them. Only
   * near-identical wording should qualify — the default sits at roughly 0.97
   * cosine similarity, a restatement rather than a related thought. Lowering it
   * is always safe; raising it trades information for tidiness; 0 stops merging.
   */
  mergeDistance: z
    .number()
    .nonnegative()
    .max(NO_FLOOR)
    .default(0.25)
    .meta({ nox: { help: 'ui.mergeDistanceHelp', label: 'ui.mergeDistance' } }),
  type: z.literal('semantic'),
});

type SemanticMemoryConfig = z.infer<typeof semanticMemoryConfigSchema>;
type SemanticMemoryConfigInput = z.input<typeof semanticMemoryConfigSchema>;

export { NO_FLOOR, semanticMemoryConfigSchema };

export type { SemanticMemoryConfig, SemanticMemoryConfigInput };
