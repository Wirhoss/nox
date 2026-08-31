import { stableStringify, z } from '@nox/extension-api';

import type { SearchCapability } from '../capabilities';
import type { MessageContent, Tool } from '@nox/extension-api';

const WEB_SEARCH_AUTHORITY = 'nox.toolset.web.search';

/**
 * The parameters this module can actually honor.
 *
 * `language` exists only where the configured module has the concept. Offering
 * an argument the backend would ignore teaches the model something false about
 * what it just asked for, so the surface is built from the capability rather
 * than from the union of everything any search service might support.
 */
function searchParameters(capability: SearchCapability) {
  const shape = {
    maxResults: z
      .number()
      .int()
      .positive()
      .max(capability.maxResults)
      .default(capability.defaultMaxResults)
      .describe('Maximum number of search results to return.'),
    query: z.string().trim().min(1).describe('The public web search query.'),
  };

  return capability.languages
    ? z.object({
        ...shape,
        language: z
          .string()
          .min(1)
          .default(capability.defaultLanguage ?? 'all')
          .describe('Language code to narrow results to, such as en, es, or all.'),
      })
    : z.object(shape);
}

function searchTool(capability: SearchCapability, origin: string): Tool {
  const parameters = searchParameters(capability);

  const tool: Tool<typeof parameters> = {
    authority: WEB_SEARCH_AUTHORITY,
    description: 'Search the public web and return result titles, URLs, and snippets.',
    name: 'web_search',
    parameters,
    prepare: (params) => ({
      risk: {
        effects: ['network', 'read'],
        resources: [{ kind: 'url', value: origin }],
        reversible: true,
      },
      run: async ({ abortSignal }): Promise<MessageContent[]> => {
        const language =
          'language' in params && typeof params.language === 'string' ? params.language : undefined;
        const results = await capability.search(
          {
            ...(language === undefined ? {} : { language }),
            maxResults: params.maxResults,
            query: params.query,
          },
          { signal: abortSignal },
        );

        return [{ text: stableStringify({ query: params.query, results }), type: 'text' }];
      },
      title: `Search web — ${params.query}`,
      type: 'immediate',
    }),
    risk: { effects: ['network', 'read'], reversible: true },
  };

  return tool;
}

export { searchTool, WEB_SEARCH_AUTHORITY };
