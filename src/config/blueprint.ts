import { z } from 'zod';

import { contextPolicySchema } from '../agent/context/options';
import { samplingParametersConfigSchema } from '../provider/config';
import { gatePolicySchema } from '../tool/gate/config';

/**
 * A declarative agent definition: one file, one agent. The file name is the
 * agent's ID, so the name a transcript is stored under is the name on disk and
 * the two cannot drift — an `id` field inside would be a second answer to the
 * same question.
 *
 * `provider` names a key in `providers.json`, not a kind: which configured
 * instance this agent talks through. Two agents may share one instance, and one
 * kind may have several instances, so the reference has to be to the instance.
 *
 * Tool-set IDs name configured instances in `toolsets.json`. Direct sets expose
 * every granted tool to the model; routed sets are discovered through the
 * built-in search/call router instead.
 */
const compactionConfigSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
});

const maxIterationsSchema = z.union([z.number().int().positive(), z.literal('unlimited')]);

/**
 * A granted tool set, and how much of it this agent gets. The bare string is
 * the whole set; the object form is an allowlist over it.
 *
 * The cut belongs to the grant rather than to the instance because one
 * configured instance is shared by every blueprint that names it: `toolsets.json`
 * decides what the instance exposes at all, and a recut stored there would be a
 * recut for every agent at once. The two compose — the instance decides what
 * exists, the blueprint decides how much of it reaches this agent.
 *
 * An allowlist and not an `exclude`, because a denylist goes stale in silence: a
 * tool added to the set later would be granted without anyone having said so.
 */
const toolSetGrantConfigSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    /**
     * Omit to grant every tool the instance exposes. The list is never empty:
     * granting a set and none of its tools is a mistake rather than a policy,
     * and it reads exactly like the grant that means "all of them".
     */
    tools: z.array(z.string().min(1)).min(1).optional(),
  }),
]);

const toolSetsConfigSchema = z.object({
  direct: z.array(toolSetGrantConfigSchema).default([]),
  routed: z.array(toolSetGrantConfigSchema).default([]),
});

const blueprintSchema = z.object({
  /** Omit the whole block to inherit the agent's provider and model. */
  compaction: compactionConfigSchema.optional(),
  context: contextPolicySchema.prefault({}),
  description: z.string().default(''),
  gate: gatePolicySchema.optional(),
  generation: samplingParametersConfigSchema.prefault({}),
  maxIterations: maxIterationsSchema.default(90),
  model: z.string().min(1),
  provider: z.string().min(1),
  systemPrompt: z.string().min(1),
  toolSets: toolSetsConfigSchema.prefault({}),
});

type Blueprint = z.infer<typeof blueprintSchema>;

type ToolSetGrantConfig = z.infer<typeof toolSetGrantConfigSchema>;

export { blueprintSchema, toolSetGrantConfigSchema };

export type { Blueprint, ToolSetGrantConfig };
