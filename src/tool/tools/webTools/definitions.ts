import { z } from 'zod';

import { crawl4aiDefinition } from './services/crawl4ai';
import { searxngDefinition } from './services/searxng';

import type { WebExtractServiceDefinition, WebSearchServiceDefinition } from './types';

type WebServicesCatalog = {
  web_extract: ReturnType<typeof renderDefinition>[];
  web_search: ReturnType<typeof renderDefinition>[];
};

function renderDefinition(definition: WebSearchServiceDefinition | WebExtractServiceDefinition): {
  contractFields: typeof definition.contractFields;
  id: string;
  label: string;
  serviceFields: typeof definition.serviceFields;
} {
  return {
    id: definition.id,
    label: definition.label,
    serviceFields: definition.serviceFields,
    contractFields: definition.contractFields,
  };
}

const webSearchDefinitions = {
  searxng: searxngDefinition,
} satisfies Record<string, WebSearchServiceDefinition>;

const webExtractDefinitions = {
  crawl4ai: crawl4aiDefinition,
} satisfies Record<string, WebExtractServiceDefinition>;

const webSearchConfigSchema = z.object({
  service: z.literal('searxng'),
  serviceConfig: searxngDefinition.serviceConfigSchema,
  contract: searxngDefinition.contractConfigSchema,
});

const webExtractConfigSchema = z.object({
  service: z.literal('crawl4ai'),
  serviceConfig: crawl4aiDefinition.serviceConfigSchema,
  contract: crawl4aiDefinition.contractConfigSchema,
});

const webToolsConfigSchema = z.object({
  web_search: webSearchConfigSchema.optional(),
  web_extract: webExtractConfigSchema.optional(),
});

type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;
type WebExtractConfig = z.infer<typeof webExtractConfigSchema>;
type WebToolsConfig = z.infer<typeof webToolsConfigSchema>;

function webServicesCatalog(): WebServicesCatalog {
  return {
    web_search: Object.values(webSearchDefinitions).map(renderDefinition),
    web_extract: Object.values(webExtractDefinitions).map(renderDefinition),
  };
}

export {
  webExtractConfigSchema,
  webExtractDefinitions,
  webSearchConfigSchema,
  webSearchDefinitions,
  webServicesCatalog,
  webToolsConfigSchema,
};

export type {
  WebExtractConfig,
  WebSearchConfig,
  WebToolsConfig,
};
