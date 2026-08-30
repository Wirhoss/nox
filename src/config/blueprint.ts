import { samplingParametersConfigSchema } from '@nox/extension-api';
import { z } from 'zod';

import { contextPolicySchema } from '../agent/context/options';
import { MEMORY_TOOL_NAMES } from '../agent/memoryToolNames';
import { gatePolicySchema } from '../tool/gate/config';

const taskModelConfigSchema = z.object({
  model: z.string().min(1),
  /**
   * Omit to stay on the agent's own provider. The usual reason to name a model
   * for an internal task is that it is cheaper or faster, not that it lives
   * somewhere else, and a second endpoint should have to be asked for.
   */
  provider: z.string().min(1).optional(),
});

/**
 * The model each internal task runs on. Every entry is optional and every
 * absent one falls back to the agent's own `provider`/`model` — a blueprint
 * that says nothing here is an agent that does all of its own work, which is
 * the sane default and the only thing most deployments need.
 *
 * These are Nox talking to itself, never the conversation: compaction rewrites
 * the working set, titling names the session. Neither is the agent answering
 * anybody, which is exactly why neither has to be the agent's model.
 */
const taskModelsConfigSchema = z.object({
  compaction: taskModelConfigSchema.optional(),
  title: taskModelConfigSchema.optional(),
});

const maxIterationsSchema = z.union([z.number().int().positive(), z.literal('unlimited')]);

/** Exactly one configured memory instance may be attached to an agent. */
/**
 * One always-present block this agent carries in its system prompt. Declared
 * here rather than created by the agent, because a block is in every request
 * whether or not it earned its place — letting the agent open new ones would
 * let it grow its own system prompt, and nothing downstream would push back.
 * The blueprint decides what exists; the agent decides what goes in.
 */
const memoryBlockConfigSchema = z.object({
  /** Shown to the model beside the value, so it knows what belongs here. */
  description: z.string().min(1).max(200).optional(),
  label: z
    .string()
    .min(1)
    .max(64)
    // Addressed by name in a tool call, so it has to be something a model can
    // reproduce exactly rather than an arbitrary string with spaces in it.
    .regex(/^[a-z][a-z0-9_]*$/u, 'A memory block label is lowercase letters, digits and _.'),
});

const memoryConfigSchema = z.object({
  /** Absent grants no always-present memory; each entry is one declared block. */
  blocks: z.array(memoryBlockConfigSchema).max(8).optional(),
  id: z.string().min(1),
  maxTokens: z.number().int().positive().max(16_384).default(2048),
  /** Absent grants no agentic access; a present allowlist is deliberately closed. */
  tools: z.array(z.enum(MEMORY_TOOL_NAMES)).min(1).optional(),
});

/**
 * A granted tool set, and how much of it this agent gets. The bare string is
 * the whole set; the object form is an allowlist over it.
 *
 * The cut belongs to the grant rather than to the instance, because one
 * configured instance is shared by every blueprint that names it: the instance
 * decides what exists, the blueprint decides how much of it reaches this agent,
 * and a recut stored at the instance would cut for every agent at once.
 *
 * An allowlist and not an `exclude`: a denylist goes stale in silence, and a
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
const blueprintSchema = z.object({
  context: contextPolicySchema.prefault({}),
  description: z.string().default(''),
  gate: gatePolicySchema.optional(),
  generation: samplingParametersConfigSchema.prefault({}),
  maxIterations: maxIterationsSchema.default(90),
  /** Omit for a stateless agent; one object selects one memory implementation. */
  memory: memoryConfigSchema.optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  systemPrompt: z.string().min(1),
  /** Per-task overrides; anything absent runs on the agent's own model. */
  taskModels: taskModelsConfigSchema.prefault({}),
  toolSets: toolSetsConfigSchema.prefault({}),
});

type Blueprint = z.infer<typeof blueprintSchema>;

type MemoryConfig = z.infer<typeof memoryConfigSchema>;

type TaskModelConfig = z.infer<typeof taskModelConfigSchema>;

type ToolSetGrantConfig = z.infer<typeof toolSetGrantConfigSchema>;

export { blueprintSchema, memoryConfigSchema, taskModelConfigSchema, toolSetGrantConfigSchema };

export type { Blueprint, MemoryConfig, TaskModelConfig, ToolSetGrantConfig };
