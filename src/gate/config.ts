import { z } from 'zod';

const gateRuleSchema = z.object({
  tools: z.union([z.literal('*'), z.array(z.string()).min(1)])
    .describe('Tool names this rule applies to, or "*" for every tool.'),
  match: z.record(z.string(), z.string()).optional()
    .describe('Per-argument regex sources; the rule fires only if every one matches the stringified argument.'),
  verdict: z.enum(['deny', 'escalate'])
    .describe('deny hard-blocks; escalate asks the user.'),
  reason: z.string()
    .describe('Shown to the user on escalation; part of the denial response on deny.'),
});

type GateRule = z.infer<typeof gateRuleSchema>;
type GateDeclaration = GateRule[];

const gateConfigSchema = z.object({
  rules: z.array(gateRuleSchema).default([]),
  escalationTimeoutMs: z.number().int().positive().default(120_000),
});

type GateConfig = z.infer<typeof gateConfigSchema>;

export {
  gateConfigSchema,
  gateRuleSchema,
};

export type {
  GateConfig,
  GateDeclaration,
  GateRule,
};
