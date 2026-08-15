import { z } from 'zod';

const brokerBaseConfigSchema = z.object({
  defaultBlueprintId: z.string().describe('Blueprint used for sessions opened by this broker.'),
  debounceMs: z.number().int().min(0).optional()
    .describe('Batching window for multi-part inbound messages before a run starts.'),
});

type BrokerBaseConfig = z.infer<typeof brokerBaseConfigSchema>;

export {
  brokerBaseConfigSchema,
};

export type {
  BrokerBaseConfig,
};
