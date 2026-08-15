import { z } from 'zod';

const toolsConfigSchema = z.object({
  //web_tools: webToolsConfigSchema.optional(),
});

type ToolsConfig = z.infer<typeof toolsConfigSchema>;

export {
  toolsConfigSchema,
};

export type {
  ToolsConfig,
};
