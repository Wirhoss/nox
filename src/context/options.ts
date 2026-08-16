import { z } from "zod";

import { parseOrThrow } from "../utils/validate";

import type { Logger } from "../logger/logger";
import type { Tool } from "../tool/tool";
import type { Message } from "./message";

const DEFAULT_COMPACT_GUARD_BEGINNING = 5;
const DEFAULT_COMPACT_GUARD_END = 5;
const DEFAULT_COMPACT_MIN_MESSAGES = 10;
const DEFAULT_FOLD_MIN_REDUCTION_RATIO = 0.2;
const DEFAULT_COMPACT_AT_RATIO = 0.8;
const DEFAULT_MAX_RESERVE_FOR_OUTPUT = 4096;
const DEFAULT_RESERVE_RATIO = 0.2;

/**
 * Only the numeric policy is validated here. History, tools, the token counter
 * and the logger are structural, and a schema over them would buy nothing.
 */
const contextPolicySchema = z
  .object({
    compactAtRatio: z.number().gt(0).max(1).optional(),
    compactGuardBeginning: z.number().int().nonnegative().optional(),
    compactGuardEnd: z.number().int().nonnegative().optional(),
    compactMinMessages: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    foldMinReductionRatio: z.number().gt(0).max(1).optional(),
    reserveForOutput: z.number().int().nonnegative().optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.contextWindow === undefined) {
      if (policy.reserveForOutput !== undefined || policy.compactAtRatio !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "contextWindow is required when configuring context pressure.",
          path: ["contextWindow"],
        });
      }
      return;
    }

    if (policy.reserveForOutput !== undefined && policy.reserveForOutput >= policy.contextWindow) {
      ctx.addIssue({
        code: "custom",
        message: "reserveForOutput must be smaller than contextWindow.",
        path: ["reserveForOutput"],
      });
    }
  });

type ContextPolicy = z.infer<typeof contextPolicySchema>;

interface ContextOptions extends ContextPolicy {
  fullHistory?: readonly Message[];
  logger?: Logger;
  tokenCounter?: (text: string) => number;
  tools?: Readonly<Record<string, Tool>>;
}

interface ResolvedContextOptions {
  compactGuardBeginning: number;
  compactGuardEnd: number;
  compactMinMessages: number;
  foldMinReductionRatio: number;
  fullHistory: readonly Message[];
  logger?: Logger;
  pressureTokenLimit?: number;
  tokenCounter?: (text: string) => number;
  tools: Readonly<Record<string, Tool>>;
}

function resolvePressureTokenLimit(policy: ContextPolicy): number | undefined {
  const { contextWindow } = policy;
  if (contextWindow === undefined) return undefined;

  const reserveForOutput =
    policy.reserveForOutput ??
    Math.min(DEFAULT_MAX_RESERVE_FOR_OUTPUT, Math.floor(contextWindow * DEFAULT_RESERVE_RATIO));
  const compactAtRatio = policy.compactAtRatio ?? DEFAULT_COMPACT_AT_RATIO;

  return Math.max(1, Math.floor((contextWindow - reserveForOutput) * compactAtRatio));
}

/** Tools are name-sorted here so the serialized prefix never depends on insertion order. */
function resolveTools(tools: Readonly<Record<string, Tool>> = {}): Readonly<Record<string, Tool>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(tools)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, tool]) => [name, Object.freeze({ ...tool })]),
    ),
  );
}

function resolveContextOptions(options: ContextOptions): ResolvedContextOptions {
  const policy = parseOrThrow(contextPolicySchema, options);

  return {
    compactGuardBeginning: policy.compactGuardBeginning ?? DEFAULT_COMPACT_GUARD_BEGINNING,
    compactGuardEnd: policy.compactGuardEnd ?? DEFAULT_COMPACT_GUARD_END,
    compactMinMessages: policy.compactMinMessages ?? DEFAULT_COMPACT_MIN_MESSAGES,
    foldMinReductionRatio: policy.foldMinReductionRatio ?? DEFAULT_FOLD_MIN_REDUCTION_RATIO,
    fullHistory: options.fullHistory ?? [],
    logger: options.logger,
    pressureTokenLimit: resolvePressureTokenLimit(policy),
    tokenCounter: options.tokenCounter,
    tools: resolveTools(options.tools),
  };
}

export { contextPolicySchema, resolveContextOptions };

export type { ContextOptions, ContextPolicy, ResolvedContextOptions };
