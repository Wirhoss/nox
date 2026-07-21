import { z } from 'zod';

const deliberationConfigurationSchema = z.object({
  moderatorBlueprintId: z.string().trim().min(1).max(120),
  participantBlueprintIds: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
  rounds: z.number().int().min(1).max(100),
}).superRefine((input, context) => {
  if (new Set(input.participantBlueprintIds).size !== input.participantBlueprintIds.length) {
    context.addIssue({ code: 'custom', message: 'Participant blueprints must be unique.', path: ['participantBlueprintIds'] });
  }
});

const createDeliberationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(4_000),
  participantBlueprintIds: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
  moderatorBlueprintId: z.string().trim().min(1).max(120),
  rounds: z.number().int().min(1).max(100).default(2),
});

type CreateDeliberation = z.infer<typeof createDeliberationSchema>;
type DeliberationConfiguration = z.infer<typeof deliberationConfigurationSchema>;

export {
  createDeliberationSchema,
  deliberationConfigurationSchema,
};

export type {
  CreateDeliberation,
  DeliberationConfiguration,
};
