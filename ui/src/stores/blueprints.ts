/*
 * Blueprint library and editor.
 *
 * One store backs three routes — the library, the create form, and the edit
 * form — because they share a draft shape, a validator, and the same catalog
 * of providers, models, and tools. `loadWorkbench` takes the view so the edit
 * route can resolve its subject in the same pass that fills the catalog.
 *
 * `originalId` is kept separately from `draft.id`: the id is editable, and a
 * rename has to PUT to the path the blueprint currently lives at, not the one
 * it is being renamed to.
 */

import { atom, computed, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';
import { isValidResourceId } from '../utils/validation';

import {
  blueprints,
  loadBlueprints,
  loadModels,
  loadProviders,
  loadTools,
  modelsByProvider,
  modelsFor,
  providers,
  tools,
} from './catalog';

import type { Blueprint, ModelConfig } from '../utils/types';

type WorkbenchView = 'library' | 'new' | 'edit';
type ToolMode = 'core' | 'lazy';

type BlueprintStatus = {
  deleting: boolean;
  error: string;
  formError: string;
  loading: boolean;
  saving: boolean;
};

const DEFAULT_MAX_ITERATIONS = 90;

const emptyDraft = (): Blueprint => ({
  config: { maxIterations: DEFAULT_MAX_ITERATIONS, modelId: '', providerId: '' },
  coreTools: [],
  description: '',
  id: '',
  lazyLoadedTools: [],
  systemPrompt: '',
});

const draft = atom<Blueprint>(emptyDraft());
/** The id the blueprint was loaded under; the save path is built from this. */
const originalId = atom<string>('');
const query = atom<string>('');
const toolPickerMode = atom<ToolMode | null>(null);
const toolPickerQuery = atom<string>('');
const status = map<BlueprintStatus>({
  deleting: false,
  error: '',
  formError: '',
  loading: true,
  saving: false,
});

const filteredBlueprints = computed([blueprints, query], (all, search) => {
  const needle = search.trim().toLowerCase();
  return all.filter((blueprint) =>
    `${blueprint.id} ${blueprint.description} ${blueprint.config.providerId} ${blueprint.config.modelId}`
      .toLowerCase()
      .includes(needle));
});

const assignedToolCount = computed(draft, (current) => current.coreTools.length + current.lazyLoadedTools.length);

const unassignedTools = computed([tools, draft], (all, current) =>
  all.filter((tool) => !current.coreTools.includes(tool) && !current.lazyLoadedTools.includes(tool)));

const filteredUnassignedTools = computed([unassignedTools, toolPickerQuery], (all, search) =>
  all.filter((tool) => tool.toLowerCase().includes(search.trim().toLowerCase())));

const selectedProvider = computed([providers, draft], (all, current) =>
  all.find((provider) => provider.id === current.config.providerId) ?? null);

/*
 * `modelsByProvider` is listed as a dependency even though the value is read
 * through `modelsFor`: without it this would not recompute when discovery
 * settles, and the model select would stay empty behind a chosen provider.
 */
const availableModels = computed(
  [draft, providers, modelsByProvider],
  (current) => modelsFor(current.config.providerId),
);

/**
 * The models the select may show.
 *
 * A saved blueprint can reference a model the provider no longer advertises —
 * because discovery failed, or the model was withdrawn. Appending it keeps the
 * select from silently resetting a choice the user never changed.
 */
const selectableModels = computed([availableModels, draft], (models, current): ModelConfig[] =>
  current.config.modelId && !models.some((model) => model.modelId === current.config.modelId)
    ? [...models, { modelId: current.config.modelId, type: 'text' }]
    : models);

/* --------------------------------------------------------------- internals */

const blueprintPath = (id: string): string => `/api/v1/blueprints/${encodeURIComponent(id)}`;

const updateDraft = (patch: Partial<Blueprint>): void => {
  draft.set({ ...draft.get(), ...patch });
};

/* ----------------------------------------------------------------- actions */

const loadWorkbench = async (view: WorkbenchView): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  try {
    const [blueprintData, providerData] = await Promise.all([loadBlueprints(), loadProviders(), loadTools()]);
    await loadModels(providerData);

    if (view === 'edit') {
      const id = new URLSearchParams(window.location.search).get('id');
      if (!id) throw new Error('No blueprint was selected for editing.');
      // Prefer the copy already in the list; fall back to a direct read so a
      // deep link to a blueprint outside the page still resolves.
      const blueprint = blueprintData.find((item) => item.id === id)
        ?? await request<Blueprint>(blueprintPath(id));
      draft.set(structuredClone(blueprint));
      originalId.set(blueprint.id);
      return;
    }

    if (view === 'new') {
      const fresh = emptyDraft();
      // With a single option there is no choice to make, so it is preselected.
      if (providerData.length === 1) fresh.config.providerId = providerData[0]!.id;
      const models = modelsFor(fresh.config.providerId);
      if (models.length === 1) fresh.config.modelId = models[0]!.modelId;
      draft.set(fresh);
    }
  } catch (error) {
    status.setKey('error', errorMessage(error, 'The workbench data could not be loaded.'));
  } finally {
    status.setKey('loading', false);
  }
};

const setQuery = (value: string): void => query.set(value);
const setToolPickerQuery = (value: string): void => toolPickerQuery.set(value);

const setDraftField = <Key extends keyof Blueprint>(key: Key, value: Blueprint[Key]): void => {
  updateDraft({ [key]: value } as Partial<Blueprint>);
};

const setConfigField = <Key extends keyof Blueprint['config']>(
  key: Key,
  value: Blueprint['config'][Key],
): void => {
  updateDraft({ config: { ...draft.get().config, [key]: value } });
};

/**
 * Switches provider, keeping the model only if the new provider offers it.
 *
 * Model ids are not unique across providers, so a carried-over id would
 * usually name nothing. It is cleared unless the new provider has exactly one
 * model, in which case that one is adopted.
 */
const selectProvider = (providerId: string): void => {
  const models = modelsFor(providerId);
  const current = draft.get().config.modelId;
  updateDraft({
    config: {
      ...draft.get().config,
      modelId: models.some((model) => model.modelId === current)
        ? current
        : (models.length === 1 ? models[0]!.modelId : ''),
      providerId,
    },
  });
};

/** Assigns a tool to one list, removing it from the other so it appears once. */
const addTool = (id: string, mode: ToolMode): void => {
  const current = draft.get();
  const coreTools = current.coreTools.filter((tool) => tool !== id);
  const lazyLoadedTools = current.lazyLoadedTools.filter((tool) => tool !== id);
  updateDraft({
    coreTools: mode === 'core' ? [...coreTools, id] : coreTools,
    lazyLoadedTools: mode === 'lazy' ? [...lazyLoadedTools, id] : lazyLoadedTools,
  });
  toolPickerQuery.set('');
};

const removeTool = (id: string, mode: ToolMode): void => {
  const current = draft.get();
  updateDraft(mode === 'core'
    ? { coreTools: current.coreTools.filter((tool) => tool !== id) }
    : { lazyLoadedTools: current.lazyLoadedTools.filter((tool) => tool !== id) });
};

const toggleToolPicker = (mode: ToolMode): void => {
  toolPickerMode.set(toolPickerMode.get() === mode ? null : mode);
  toolPickerQuery.set('');
};

/** Returns the first problem with the draft, or an empty string when valid. */
const validateDraft = (): string => {
  const current = draft.get();
  if (!current.id.trim()) return 'Give this blueprint an ID.';
  if (!isValidResourceId(current.id)) return 'Use only letters, numbers, hyphens, and underscores in the ID.';
  if (!current.description.trim()) return 'Add a short description.';
  if (!current.systemPrompt.trim()) return 'Add system instructions.';
  if (!current.config.providerId) return 'Select a provider.';
  if (!current.config.modelId) return 'Select a model.';
  if (!Number.isInteger(current.config.maxIterations) || current.config.maxIterations < 1) {
    return 'Max iterations must be a positive whole number.';
  }
  return '';
};

/**
 * Saves the draft and returns to the library.
 *
 * Navigation happens here rather than in the component because a successful
 * save always leaves the editor — there is no post-save state to render.
 */
const saveBlueprint = async (view: WorkbenchView): Promise<void> => {
  const formError = validateDraft();
  status.setKey('formError', formError);
  if (formError) return;

  status.setKey('saving', true);
  try {
    await request<Blueprint>(view === 'new' ? '/api/v1/blueprints' : blueprintPath(originalId.get()), {
      body: JSON.stringify(draft.get()),
      method: view === 'new' ? 'POST' : 'PUT',
    });
    window.location.assign('/blueprints');
  } catch (error) {
    status.setKey('formError', errorMessage(error, 'The blueprint could not be saved.'));
  } finally {
    status.setKey('saving', false);
  }
};

const deleteBlueprint = async (): Promise<void> => {
  status.setKey('deleting', true);
  status.setKey('formError', '');
  try {
    await request<void>(blueprintPath(originalId.get()), { method: 'DELETE' });
    window.location.assign('/blueprints');
  } catch (error) {
    // The gateway refuses to delete a blueprint that sessions still use, so
    // this path is reachable in normal operation, not just on transport faults.
    status.setKey('formError', errorMessage(error, 'The blueprint could not be deleted.'));
  } finally {
    status.setKey('deleting', false);
  }
};

export {
  assignedToolCount,
  availableModels,
  draft,
  filteredBlueprints,
  filteredUnassignedTools,
  originalId,
  query,
  selectableModels,
  selectedProvider,
  status,
  toolPickerMode,
  toolPickerQuery,
  unassignedTools,
  addTool,
  deleteBlueprint,
  loadWorkbench,
  removeTool,
  saveBlueprint,
  selectProvider,
  setConfigField,
  setDraftField,
  setQuery,
  setToolPickerQuery,
  toggleToolPicker,
  validateDraft,
};

export type {
  BlueprintStatus,
  ToolMode,
  WorkbenchView,
};
