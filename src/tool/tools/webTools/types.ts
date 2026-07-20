import type { z } from 'zod';

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
};

type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

type WebExtractResult = {
  url: string;
  title?: string;
  content: string;
  truncated: boolean;
  error?: string;
};

type WebExtractResponse = {
  results: WebExtractResult[];
};

interface WebSearchService {
  search(input: {
    language?: string;
    maxResults: number;
    query: string;
  }, signal: AbortSignal): Promise<WebSearchResponse>;
}

interface WebExtractService {
  crawl(input: {
    maxCharactersPerPage: number;
    urls: string[];
  }, signal: AbortSignal): Promise<WebExtractResponse>;
}

type SettingsField = {
  defaultValue?: boolean | number | string;
  help?: string;
  label: string;
  maximum?: number;
  minimum?: number;
  name: string;
  required?: boolean;
  secret?: boolean;
  type: 'boolean' | 'number' | 'text' | 'url';
};

interface WebServiceDefinition<
  TServiceConfig extends z.ZodObject = z.ZodObject,
  TContractConfig extends z.ZodObject = z.ZodObject,
> {
  contractConfigSchema: TContractConfig;
  contractFields: SettingsField[];
  id: string;
  label: string;
  serviceConfigSchema: TServiceConfig;
  serviceFields: SettingsField[];
}

interface WebSearchServiceDefinition<
  TServiceConfig extends z.ZodObject = z.ZodObject,
  TContractConfig extends z.ZodObject = z.ZodObject,
> extends WebServiceDefinition<TServiceConfig, TContractConfig> {
  create(config: z.infer<TServiceConfig>): WebSearchService;
}

interface WebExtractServiceDefinition<
  TServiceConfig extends z.ZodObject = z.ZodObject,
  TContractConfig extends z.ZodObject = z.ZodObject,
> extends WebServiceDefinition<TServiceConfig, TContractConfig> {
  create(config: z.infer<TServiceConfig>): WebExtractService;
}

export type {
  SettingsField,
  WebExtractResponse,
  WebExtractResult,
  WebExtractService,
  WebExtractServiceDefinition,
  WebSearchResponse,
  WebSearchResult,
  WebSearchService,
  WebSearchServiceDefinition,
};
