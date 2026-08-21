import { z } from 'zod';

const apiConfigSchema = z.object({
  host: z.string().min(1).default('0.0.0.0'),
  port: z.number().int().min(0).max(65_535).default(8080),
});

type ApiConfig = z.infer<typeof apiConfigSchema>;

type ApiConfigInput = z.input<typeof apiConfigSchema>;

export { apiConfigSchema };

export type { ApiConfig, ApiConfigInput };
