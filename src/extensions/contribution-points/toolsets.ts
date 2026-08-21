import { z } from 'zod';

import { type ConfigurableContribution, createContributionPoint } from '../contribution';

import type { ToolSet } from '../../tool/tool';

/** Configuration shared by every contributed tool-set kind. */
const toolSetBaseConfigSchema = z.object({
  enabledTools: z.array(z.string().min(1)).optional(),
});

/**
 * A configured tool-set instance names the contribution that builds it through
 * `type`, just as a configured provider does. Concrete tool sets extend this
 * floor with the connection details or policy they need.
 */
const toolSetConfigSchema = toolSetBaseConfigSchema.extend({ type: z.string() });

type ToolSetConfig = z.infer<typeof toolSetConfigSchema>;

type ToolSetConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof toolSetBaseConfigSchema.shape
>;

type ToolSetContribution = ConfigurableContribution<ToolSetConfigSchema, ToolSet>;

/** Preserves a concrete tool set's schema at its declaration site. */
function toolSetContribution<TSchema extends ToolSetConfigSchema>(
  contribution: ConfigurableContribution<TSchema, ToolSet>,
): ConfigurableContribution<TSchema, ToolSet> {
  return contribution;
}

const toolSets = createContributionPoint<ToolSetContribution>('nox.toolsets');

export { toolSetBaseConfigSchema, toolSetConfigSchema, toolSetContribution, toolSets };

export type { ToolSetConfig, ToolSetConfigSchema, ToolSetContribution };
