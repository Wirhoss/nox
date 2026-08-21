import { z } from 'zod';

const gateRuleSchema = z.object({
  match: z
    .record(z.string(), z.string())
    .optional()
    .describe('Regex sources matched against validated top-level parameters.'),
  reason: z.string().trim().min(1),
  tools: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]),
  toolSets: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]).default('*'),
  verdict: z.enum(['allow', 'deny', 'escalate']),
});

const heuristicPolicySchema = z.object({
  allowedDomains: z.array(z.string().trim().min(1)).default([]),
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
  maxBatchSize: z.number().int().positive().default(100),
  sensitivePathPatterns: z
    .array(z.string().trim().min(1))
    .default(['(^|[\\\\/])\\.env($|[.\\\\/])', 'id_rsa', 'credentials', '\\.pem$']),
});

const gatePolicySchema = z
  .object({
    defaultVerdict: z.enum(['allow', 'deny', 'escalate']),
    escalationTimeoutMs: z.number().int().positive().default(120_000),
    heuristics: heuristicPolicySchema.default({
      allowedDomains: [],
      allowedRoots: [],
      enabled: true,
      maxBatchSize: 100,
      sensitivePathPatterns: ['(^|[\\\\/])\\.env($|[.\\\\/])', 'id_rsa', 'credentials', '\\.pem$'],
    }),
    rules: z.array(gateRuleSchema).default([]),
  })
  .superRefine(({ heuristics, rules }, ctx) => {
    for (const [patternIndex, source] of heuristics.sensitivePathPatterns.entries()) {
      try {
        new RegExp(source, 'i');
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid sensitive path regular expression.',
          path: ['heuristics', 'sensitivePathPatterns', patternIndex],
        });
      }
    }

    for (const [ruleIndex, rule] of rules.entries()) {
      for (const [parameter, source] of Object.entries(rule.match ?? {})) {
        try {
          new RegExp(source);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid regular expression for parameter ${parameter}.`,
            path: ['rules', ruleIndex, 'match', parameter],
          });
        }
      }
    }
  });

type GatePolicy = z.infer<typeof gatePolicySchema>;
type GatePolicyInput = z.input<typeof gatePolicySchema>;
type GateRule = z.infer<typeof gateRuleSchema>;

export { gatePolicySchema, gateRuleSchema, heuristicPolicySchema };

export type { GatePolicy, GatePolicyInput, GateRule };
