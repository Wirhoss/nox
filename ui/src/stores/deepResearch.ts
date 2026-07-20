import { atom, computed, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';

import type { CreateDeepResearch, DeepResearch } from '../utils/types';

const items = atom<DeepResearch[]>([]);
const draft = atom<CreateDeepResearch>({ objective: '', title: '' });
const query = atom('');
const status = map({ error: '', formError: '', loading: true, saving: false });

const filteredItems = computed([items, query], (all, search) => {
  const needle = search.trim().toLowerCase();
  return all.filter((item) =>
    !needle || `${item.title} ${item.objective}`.toLowerCase().includes(needle));
});

const load = async (freshDraft = false): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  status.setKey('formError', '');
  if (freshDraft) draft.set({ objective: '', title: '' });
  try {
    items.set(await request<DeepResearch[]>('/api/v1/deep-research'));
  } catch (error) {
    status.setKey('error', errorMessage(error, 'Deep Research activities could not be loaded.'));
  } finally {
    status.setKey('loading', false);
  }
};

const setDraftField = <Key extends keyof CreateDeepResearch>(
  key: Key,
  value: CreateDeepResearch[Key],
): void => {
  draft.set({ ...draft.get(), [key]: value });
  status.setKey('formError', '');
};

const save = async (): Promise<void> => {
  if (!draft.get().title.trim() || !draft.get().objective.trim()) {
    status.setKey('formError', 'Add a title and a concrete research outcome.');
    return;
  }
  status.setKey('saving', true);
  try {
    const created = await request<DeepResearch>('/api/v1/deep-research', {
      body: JSON.stringify(draft.get()),
      method: 'POST',
    });
    window.location.assign(`/deep-research?created=${encodeURIComponent(created.researchId)}`);
  } catch (error) {
    status.setKey('formError', errorMessage(error, 'The research draft could not be created.'));
  } finally {
    status.setKey('saving', false);
  }
};

export {
  draft,
  filteredItems,
  items,
  load,
  query,
  save,
  setDraftField,
  status,
};
