import { z } from 'zod';

const gateRuleSchema = z.object({
  tools: z.union([z.literal('*'), z.array(z.string()).min(1)])
    .describe('Tool names this rule applies to, or "*" for every tool.'),
  toolSets: z.union([z.literal('*'), z.array(z.string()).min(1)]).default('*')
    .describe('Tool set ids this rule applies to, or "*" for every set.'),
  match: z.record(z.string(), z.string()).optional()
    .describe(
      'Per-parameter regex sources; the rule fires only if every one matches the stringified '
      + 'parameter. Parameters are the validated ones, not the raw model output.',
    ),
  verdict: z.enum(['allow', 'deny', 'escalate'])
    .describe(
      'deny hard-blocks, escalate asks the user, allow approves without asking. Within the rule '
      + 'set deny beats escalate beats allow, so an allow can never unblock a denied call.',
    ),
  reason: z.string()
    .describe('Shown to the user on escalation; part of the response the model gets on deny.'),
});

type GateRule = z.infer<typeof gateRuleSchema>;
type GateDeclaration = GateRule[];

const reviewerConfigSchema = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(false),
  }),
  z.object({
    enabled: z.literal(true),
    providerId: z.string()
      .describe('Provider used for review calls; independent of the agent\'s own provider.'),
    modelId: z.string()
      .describe('Model used for review calls. A small, fast model is usually the right pick.'),
    appliesTo: z.union([z.literal('*'), z.array(z.string()).min(1)]).default('*')
      .describe(
        'Tool names or tool set ids worth reviewing. Keep it narrow: every covered call costs a '
        + 'model round trip.',
      ),
    onError: z.enum(['abstain', 'escalate']).default('abstain')
      .describe(
        'What a timeout, provider error or unparseable answer means. abstain falls back to the '
        + 'deterministic rules; escalate asks the user instead.',
      ),
    timeoutMs: z.number().int().positive().default(15_000),
    policy: z.string().optional()
      .describe('House rules appended to the reviewer system prompt, in prose.'),
  }),
]);

type ReviewerConfig = z.infer<typeof reviewerConfigSchema>;
type EnabledReviewerConfig = Extract<ReviewerConfig, { enabled: true }>;

const gateConfigSchema = z.object({
  rules: z.array(gateRuleSchema).default([]),
  escalationTimeoutMs: z.number().int().positive().default(120_000),
  reviewer: reviewerConfigSchema.default({ enabled: false }),
});

type GateConfig = z.infer<typeof gateConfigSchema>;

export {
  gateConfigSchema,
  gateRuleSchema,
  reviewerConfigSchema,
};

export type {
  EnabledReviewerConfig,
  GateConfig,
  GateDeclaration,
  GateRule,
  ReviewerConfig,
};
