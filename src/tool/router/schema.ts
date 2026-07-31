import { z } from 'zod';

const callToolSchema = z.object({
  name: z.string().describe(
    'Exact tool name returned by search_tool.'
  ),
  params: z.string().describe(
    'JSON string containing the tool arguments.'
  ),
});

const searchToolSchema = z.object({
  query: z.string().describe(
    'A short capability search (1-6 words). Examples: ' +
    '\'list files\', \'read file\', \'send email\', \'postgres query\'. ' +
    'Prefer one broad search instead of many narrow searches.'
  ),
});

export {
  searchToolSchema,
  callToolSchema,
};