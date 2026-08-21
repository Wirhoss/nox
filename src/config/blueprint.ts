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
 * every selected tool to the model; routed sets are discovered through the
 * built-in search/call router instead.
 */
const compactionConfigSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
});

const maxIterationsSchema = z.union([z.number().int().positive(), z.literal('unlimited')]);

const toolSetsConfigSchema = z.object({
  direct: z.array(z.string().min(1)).default([]),
  routed: z.array(z.string().min(1)).default([]),
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

export { blueprintSchema };

export type { Blueprint };
