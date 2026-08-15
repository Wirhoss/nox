/*
 * Provider library and editor.
 *
 * Mirrors `stores/blueprints.ts` in shape — one store across the library, the
 * create form, and the edit form — but differs in two ways that matter:
 *
 * - Provider changes only take effect when Nox restarts, because provider
 *   instances and model discovery are built at startup. Every mutation
 *   therefore returns to the library with `?restart=1`, which raises the
 *   reminder banner.
 * - The API key is write-only. Reads report `hasApiKey` and never the value,
 *   so the payload carries a key only when one was typed, or an empty string
 *   when the user explicitly asked to remove the stored one. Omitting the
 *   field leaves the credential as it is.
 */

import { atom, computed, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';
import { isValidResourceId, isValidUrl } from '../utils/validation';

import { loadModels, loadProviders, providers } from './catalog';

import type { ModelConfig, Provider, ProviderMutation } from '../utils/types';

type WorkbenchView = 'library' | 'new' | 'edit';

type ProviderDraft = {
  baseUrl: string;
  defaultModel?: string;
  id: string;
  modelConfigs: ModelConfig[];
  timeoutMs?: number;
  type: Provider['type'];
};

type ProviderStatus = {
  deleting: boolean;
  error: string;
  formError: string;
  loading: boolean;
  saving: boolean;
};

const emptyDraft = (): ProviderDraft => ({
  baseUrl: '',
  id: '',
  modelConfigs: [],
  type: 'openai_completions',
});

const draft = atom<ProviderDraft>(emptyDraft());
const originalId = atom<string>('');
const query = atom<string>('');
/** Whether the provider being edited already has a credential stored. */
const storedApiKey = atom<boolean>(false);
const newApiKey = atom<string>('');
const clearApiKey = atom<boolean>(false);
const restartNotice = atom<boolean>(false);
const status = map<ProviderStatus>({
  deleting: false,
  error: '',
  formError: '',
  loading: true,
  saving: false,
});

const filteredProviders = computed([providers, query], (all, search) => {
  const needle = search.trim().toLowerCase();
  return all.filter((provider) =>
    `${provider.id} ${provider.type} ${provider.baseUrl}`.toLowerCase().includes(needle));
});

const identityValid = computed(draft, (current) => Boolean(current.id) && isValidResourceId(current.id));
const endpointValid = computed(draft, (current) => isValidUrl(current.baseUrl));

/** A credential is ready when one was typed, or one is stored and kept. */
const credentialsReady = computed([newApiKey, storedApiKey, clearApiKey], (typed, stored, clearing) =>
  Boolean(typed || (stored && !clearing)));

const configuredModelCount = computed(draft, (current) =>
  current.modelConfigs.filter((model) => model.modelId.trim()).length);

/* --------------------------------------------------------------- internals */

const providerPath = (id: string): string => `/api/v1/providers/${encodeURIComponent(id)}`;

/** Every mutation lands here: the library, with the restart reminder raised. */
const returnToLibrary = (): void => window.location.assign('/providers?restart=1');

const updateDraft = (patch: Partial<ProviderDraft>): void => {
  draft.set({ ...draft.get(), ...patch });
};

/* ----------------------------------------------------------------- actions */

const loadWorkbench = async (view: WorkbenchView): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  try {
    const providerData = await loadProviders();

    if (view === 'library') {
      restartNotice.set(new URLSearchParams(window.location.search).has('restart'));
      await loadModels(providerData);
    }

    if (view === 'edit') {
      const id = new URLSearchParams(window.location.search).get('id');
      if (!id) throw new Error('No provider was selected for editing.');
      const provider = providerData.find((item) => item.id === id)
        ?? await request<Provider>(providerPath(id));
      draft.set({
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        id: provider.id,
        modelConfigs: structuredClone(provider.modelConfigs ?? []),
        timeoutMs: provider.timeoutMs,
        type: provider.type,
      });
      originalId.set(provider.id);
      storedApiKey.set(provider.hasApiKey);
    }

    if (view === 'new') draft.set(emptyDraft());
  } catch (error) {
    status.setKey('error', errorMessage(error, 'Provider data could not be loaded.'));
  } finally {
    status.setKey('loading', false);
  }
};

const setQuery = (value: string): void => query.set(value);
const setNewApiKey = (value: string): void => newApiKey.set(value);
const setClearApiKey = (value: boolean): void => clearApiKey.set(value);
const dismissRestartNotice = (): void => restartNotice.set(false);

const setDraftField = <Key extends keyof ProviderDraft>(key: Key, value: ProviderDraft[Key]): void => {
  updateDraft({ [key]: value } as Partial<ProviderDraft>);
};

const addModel = (): void => {
  updateDraft({ modelConfigs: [...draft.get().modelConfigs, { modelId: '', type: 'text' }] });
};

const removeModel = (index: number): void => {
  updateDraft({ modelConfigs: draft.get().modelConfigs.filter((_, modelIndex) => modelIndex !== index) });
};

const updateModel = <Key extends keyof ModelConfig>(index: number, key: Key, value: ModelConfig[Key]): void => {
  const current = draft.get().modelConfigs[index];
  if (!current) return;
  updateDraft({ modelConfigs: draft.get().modelConfigs.with(index, { ...current, [key]: value }) });
};

/** Returns the first problem with the draft, or an empty string when valid. */
const validateDraft = (): string => {
  const current = draft.get();
  if (!current.id.trim()) return 'Give this provider an ID.';
  if (!isValidResourceId(current.id)) return 'Use only letters, numbers, hyphens, and underscores in the ID.';
  if (!current.baseUrl.trim()) return 'Add the provider base URL.';
  if (!isValidUrl(current.baseUrl)) return 'Enter a valid absolute base URL.';
  if (current.timeoutMs !== undefined && (!Number.isFinite(current.timeoutMs) || current.timeoutMs <= 0)) {
    return 'Timeout must be greater than zero.';
  }

  const modelIds = current.modelConfigs.map((model) => model.modelId.trim());
  if (modelIds.some((id) => !id)) return 'Every configured model needs an ID.';
  if (new Set(modelIds).size !== modelIds.length) return 'Model IDs must be unique.';
  if (current.modelConfigs.some((model) => model.contextWindow !== undefined
    && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0))) {
    return 'Context windows must be positive whole numbers.';
  }
  return '';
};

const saveProvider = async (view: WorkbenchView): Promise<void> => {
  const formError = validateDraft();
  status.setKey('formError', formError);
  if (formError) return;

  status.setKey('saving', true);
  try {
    const current = draft.get();
    const config = {
      // A trailing slash would double up against the API's own paths.
      baseUrl: current.baseUrl.trim().replace(/\/+$/, ''),
      type: current.type,
      ...(newApiKey.get() ? { apiKey: newApiKey.get() } : clearApiKey.get() ? { apiKey: '' } : {}),
      ...(current.defaultModel?.trim() ? { defaultModel: current.defaultModel.trim() } : {}),
      ...(current.timeoutMs ? { timeoutMs: current.timeoutMs } : {}),
      // An empty list means "discover at runtime", so it is omitted rather
      // than sent as an explicit empty override.
      ...(current.modelConfigs.length > 0
        ? {
          modelConfigs: current.modelConfigs.map((model) => ({
            modelId: model.modelId.trim(),
            type: 'text' as const,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          })),
        }
        : {}),
    };

    await request<ProviderMutation>(view === 'new' ? '/api/v1/providers' : providerPath(originalId.get()), {
      body: JSON.stringify(view === 'new' ? { config, id: current.id.trim() } : config),
      method: view === 'new' ? 'POST' : 'PUT',
    });
    returnToLibrary();
  } catch (error) {
    status.setKey('formError', errorMessage(error, 'The provider could not be saved.'));
  } finally {
    status.setKey('saving', false);
  }
};

const deleteProvider = async (): Promise<void> => {
  status.setKey('deleting', true);
  status.setKey('formError', '');
  try {
    await request<ProviderMutation>(providerPath(originalId.get()), { method: 'DELETE' });
    returnToLibrary();
  } catch (error) {
    // Blocked while a blueprint still references the provider, so this is an
    // expected outcome rather than only a transport failure.
    status.setKey('formError', errorMessage(error, 'The provider could not be deleted.'));
  } finally {
    status.setKey('deleting', false);
  }
};

export {
  clearApiKey,
  configuredModelCount,
  credentialsReady,
  draft,
  endpointValid,
  filteredProviders,
  identityValid,
  newApiKey,
  originalId,
  query,
  restartNotice,
  status,
  storedApiKey,
  addModel,
  deleteProvider,
  dismissRestartNotice,
  loadWorkbench,
  removeModel,
  saveProvider,
  setClearApiKey,
  setDraftField,
  setNewApiKey,
  setQuery,
  updateModel,
  validateDraft,
};

export type {
  ProviderDraft,
  ProviderStatus,
  WorkbenchView,
};
