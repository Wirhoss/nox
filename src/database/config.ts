import { z } from "zod";

const SYNCHRONOUS_MODES = ["extra", "full", "normal", "off"] as const;

const databaseConfigSchema = z.object({
  busyTimeoutMs: z.number().int().nonnegative().default(5000),
  path: z.string().min(1).default("nox.db"),
  synchronous: z.enum(SYNCHRONOUS_MODES).default("normal"),
});

type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

type DatabaseConfigInput = z.input<typeof databaseConfigSchema>;

export { databaseConfigSchema };

export type { DatabaseConfig, DatabaseConfigInput };
