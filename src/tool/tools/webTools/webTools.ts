import { z } from 'zod';

import { ToolSet } from '../../tool';

import { webExtractDefinitions, webSearchDefinitions } from './definitions';

import type { MessageContentText } from '../../../provider';
import type { ImmediateTool } from '../../tool';
import type { WebToolsConfig } from './definitions';

function textResponse(value: unknown): MessageContentText[] {
  return [{ type: 'text' as const, text: JSON.stringify(value) }];
}

function webUrlSchema(description: string): z.ZodType<string> {
  return z.url().refine(value => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'Only HTTP and HTTPS URLs are supported.').describe(description);
}

class WebTools extends ToolSet {
  constructor(config: WebToolsConfig) {
    super();
    if (config.web_search) {
      this.addSearchTool(config.web_search);
    }
    if (config.web_extract) {
      this.addExtractTool(config.web_extract);
    }
  }

  private addSearchTool(config: NonNullable<WebToolsConfig['web_search']>): void {
    const definition = webSearchDefinitions[config.service];
    const service = definition.create(config.serviceConfig);
    const maxResults = z.number()
      .int()
      .positive()
      .max(config.contract.maxResults.maximum)
      .default(config.contract.maxResults.default)
      .describe('Maximum number of search results to return.');
    const parameters = config.contract.language.enabled
      ? z.object({
        query: z.string().min(1).describe('The web search query.'),
        maxResults,
        language: z.string().min(1).default(config.contract.language.default ?? 'all')
          .describe('Search language code, such as en, es, or all.'),
      })
      : z.object({
        query: z.string().min(1).describe('The web search query.'),
        maxResults,
      });

    const tool: ImmediateTool<typeof parameters> = {
      type: 'immediate',
      name: 'web_search',
      description: 'Search the public web and return normalized result titles, URLs, and snippets.',
      parameters,
      call: async (params, ctx) => textResponse(await service.search({
        query: params.query,
        maxResults: params.maxResults,
        ...('language' in params && typeof params.language === 'string'
          ? { language: params.language }
          : {}),
      }, ctx.abortSignal)),
    };
    this._tools[tool.name] = tool;
  }

  private addExtractTool(config: NonNullable<WebToolsConfig['web_extract']>): void {
    const definition = webExtractDefinitions[config.service];
    const service = definition.create(config.serviceConfig);
    const parameters = z.object({
      urls: z.array(webUrlSchema('A page URL to crawl.'))
        .min(1)
        .max(config.contract.maxUrls.maximum)
        .describe('The page URLs to crawl in one batch.'),
      maxCharactersPerPage: z.number()
        .int()
        .positive()
        .max(config.contract.maxCharactersPerPage.maximum)
        .default(config.contract.maxCharactersPerPage.default)
        .describe('Maximum number of Markdown characters to return for each page.'),
    });
    const tool: ImmediateTool<typeof parameters> = {
      type: 'immediate',
      name: 'web_extract',
      description: 'Extract one or more web pages in a batch and return separate Markdown results for each URL.',
      parameters,
      call: async (params, ctx) => textResponse(await service.crawl(params, ctx.abortSignal)),
    };
    this._tools[tool.name] = tool;
  }
}

export { WebTools };
