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
 * Tool sets are absent on purpose. An agent is granted them today by a caller
 * holding the objects, and there is no way yet to name one in a file; a field
 * for it here would be configuration nothing reads.
 */
const compactionConfigSchema = z.object({
  /** Omit to compact with the agent's configured model. */
  model: z.string().min(1).optional(),
});

const maxIterationsSchema = z.union([z.number().int().positive(), z.literal('unlimited')]);

const blueprintSchema = z.object({
  compaction: compactionConfigSchema.prefault({}),
  context: contextPolicySchema.prefault({}),
  description: z.string().default(''),
  gate: gatePolicySchema.optional(),
  generation: samplingParametersConfigSchema.prefault({}),
  maxIterations: maxIterationsSchema.default(90),
  model: z.string().min(1),
  provider: z.string().min(1),
  systemPrompt: z.string().min(1),
});

type Blueprint = z.infer<typeof blueprintSchema>;

export { blueprintSchema };

export type { Blueprint };
