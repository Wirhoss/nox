/*
 * The configured inventory: blueprints, providers, tool sets, and the models
 * each provider exposes.
 *
 * These four resources are read by almost every workbench — the overview
 * counts them, the blueprint editor picks from them, the provider library
 * lists them — so the fetches live here instead of being restated per view.
 *
 * The part worth centralising is `loadModels`. A provider's models are
 * discovered at runtime by calling the provider itself, which fails whenever
 * the endpoint is unreachable or the daemon has not been restarted since the
 * provider was configured. Every caller needs the same fallback to the
 * statically configured `modelConfigs`, and needs to know which providers fell
 * back, so a stale list is not presented as authoritative.
 */

import { atom, computed } from 'nanostores';

import { request } from '../utils/api';

import type { Blueprint, ModelConfig, Provider } from '../utils/types';

const blueprints = atom<Blueprint[]>([]);
const providers = atom<Provider[]>([]);
const tools = atom<string[]>([]);
const modelsByProvider = atom<Record<string, ModelConfig[]>>({});
/** Providers whose live model list could not be read; their models are stale. */
const unavailableModelProviders = atom<Set<string>>(new Set());

const providerIds = computed(providers, (all) => all.map((provider) => provider.id));

/* --------------------------------------------------------------- internals */

const modelsPath = (providerId: string): string =>
  `/api/v1/providers/${encodeURIComponent(providerId)}/models`;

const byModelId = (left: ModelConfig, right: ModelConfig): number =>
  left.modelId.localeCompare(right.modelId);

/* ----------------------------------------------------------------- actions */

const loadBlueprints = async (): Promise<Blueprint[]> => {
  const data = await request<Blueprint[]>('/api/v1/blueprints');
  blueprints.set(data);
  return data;
};

const loadProviders = async (): Promise<Provider[]> => {
  const data = await request<Provider[]>('/api/v1/providers');
  providers.set(data);
  return data;
};

const loadTools = async (): Promise<string[]> => {
  const data = await request<string[]>('/api/v1/tools');
  tools.set(data);
  return data;
};

/**
 * Reads every provider's live model list in parallel.
 *
 * Uses `allSettled` rather than `all` because one unreachable provider must
 * not blank out the others. A rejected lookup falls back to that provider's
 * configured models and records the id in `unavailableModelProviders`.
 *
 * Pass the provider list explicitly when it was just fetched, so this does not
 * race the store update.
 */
const loadModels = async (list: Provider[] = providers.get()): Promise<void> => {
  const results = await Promise.allSettled(list.map((provider) => request<ModelConfig[]>(modelsPath(provider.id))));

  const nextModels: Record<string, ModelConfig[]> = {};
  const unavailable = new Set<string>();
  for (const [index, provider] of list.entries()) {
    const result = results[index];
    const models = result?.status === 'fulfilled' ? result.value : (provider.modelConfigs ?? []);
    nextModels[provider.id] = [...models].sort(byModelId);
    if (result?.status !== 'fulfilled') unavailable.add(provider.id);
  }

  modelsByProvider.set(nextModels);
  unavailableModelProviders.set(unavailable);
};

/**
 * The models to offer for a provider.
 *
 * Falls back to the configured list when discovery has not run yet, so an
 * editor opened before `loadModels` settles still shows the saved choices
 * rather than an empty select.
 */
const modelsFor = (providerId: string): ModelConfig[] =>
  modelsByProvider.get()[providerId]
  ?? providers.get().find((provider) => provider.id === providerId)?.modelConfigs
  ?? [];

export {
  blueprints,
  modelsByProvider,
  modelsFor,
  providerIds,
  providers,
  tools,
  unavailableModelProviders,
  loadBlueprints,
  loadModels,
  loadProviders,
  loadTools,
};
