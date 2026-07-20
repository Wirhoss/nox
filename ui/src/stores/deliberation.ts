import { atom, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';

import { blueprints, loadBlueprints } from './catalog';

import type {
  CreateDeliberation,
  Deliberation,
  DeliberationConfiguration,
  DeliberationDetail,
} from '../utils/types';

const emptyDraft = (): CreateDeliberation => ({
  moderatorBlueprintId: '',
  participantBlueprintIds: [],
  question: '',
  rounds: 2,
  title: '',
});

const items = atom<Deliberation[]>([]);
const detail = atom<DeliberationDetail | null>(null);
const draft = atom<CreateDeliberation>(emptyDraft());
const query = atom('');
const status = map({
  action: '' as '' | 'saving' | 'starting' | 'cancelling' | 'configuring',
  actionError: '',
  error: '',
  formError: '',
  loading: true,
});

const load = async (freshDraft = false): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  status.setKey('formError', '');
  if (freshDraft) draft.set(emptyDraft());
  try {
    const operations: Promise<unknown>[] = [request<Deliberation[]>('/api/v1/deliberations').then((data) => items.set(data))];
    if (freshDraft) operations.push(loadBlueprints());
    await Promise.all(operations);
  } catch (error) {
    status.setKey('error', errorMessage(error, 'Deliberations could not be loaded.'));
  } finally {
    status.setKey('loading', false);
  }
};

const loadDetail = async (deliberationId: string, silent = false): Promise<void> => {
  if (!silent) status.setKey('loading', true);
  status.setKey('error', '');
  try {
    const [loaded] = await Promise.all([
      request<DeliberationDetail>(`/api/v1/deliberations/${encodeURIComponent(deliberationId)}`),
      blueprints.get().length > 0 ? Promise.resolve(blueprints.get()) : loadBlueprints(),
    ]);
    detail.set(loaded);
  } catch (error) {
    status.setKey('error', errorMessage(error, 'The deliberation could not be loaded.'));
  } finally {
    if (!silent) status.setKey('loading', false);
  }
};

const setDraftField = <Key extends keyof CreateDeliberation>(
  key: Key,
  value: CreateDeliberation[Key],
): void => {
  draft.set({ ...draft.get(), [key]: value });
  status.setKey('formError', '');
};

const validateConfiguration = (input: CreateDeliberation | DeliberationConfiguration): string => {
  if (input.participantBlueprintIds.length < 2) return 'Select at least two participant blueprints.';
  if (input.participantBlueprintIds.length > 8) return 'Select no more than eight participant blueprints.';
  if (!input.moderatorBlueprintId) return 'Select a moderator blueprint.';
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 100) return 'Maximum rounds must be between 1 and 100.';
  return '';
};

const save = async (): Promise<void> => {
  const input = draft.get();
  if (!input.title.trim() || !input.question.trim()) {
    status.setKey('formError', 'Add a title and the decision question the group must answer.');
    return;
  }
  const configurationError = validateConfiguration(input);
  if (configurationError) {
    status.setKey('formError', configurationError);
    return;
  }
  status.setKey('action', 'saving');
  try {
    const created = await request<Deliberation>('/api/v1/deliberations', {
      body: JSON.stringify(input),
      method: 'POST',
    });
    window.location.assign(`/deliberation/detail?id=${encodeURIComponent(created.deliberationId)}`);
  } catch (error) {
    status.setKey('formError', errorMessage(error, 'The deliberation draft could not be created.'));
  } finally {
    status.setKey('action', '');
  }
};

const configure = async (deliberationId: string, input: DeliberationConfiguration): Promise<boolean> => {
  const validationError = validateConfiguration(input);
  if (validationError) {
    status.setKey('actionError', validationError);
    return false;
  }
  status.setKey('action', 'configuring');
  status.setKey('actionError', '');
  try {
    detail.set(await request<DeliberationDetail>(`/api/v1/deliberations/${encodeURIComponent(deliberationId)}`, {
      body: JSON.stringify(input),
      method: 'PUT',
    }));
    return true;
  } catch (error) {
    status.setKey('actionError', errorMessage(error, 'The configuration could not be saved.'));
    return false;
  } finally {
    status.setKey('action', '');
  }
};

const start = async (deliberationId: string): Promise<void> => {
  status.setKey('action', 'starting');
  status.setKey('actionError', '');
  try {
    detail.set(await request<DeliberationDetail>(`/api/v1/deliberations/${encodeURIComponent(deliberationId)}/run`, {
      method: 'POST',
    }));
  } catch (error) {
    status.setKey('actionError', errorMessage(error, 'The deliberation could not be started.'));
  } finally {
    status.setKey('action', '');
  }
};

const cancel = async (deliberationId: string): Promise<void> => {
  status.setKey('action', 'cancelling');
  status.setKey('actionError', '');
  try {
    detail.set(await request<DeliberationDetail>(`/api/v1/deliberations/${encodeURIComponent(deliberationId)}/cancel`, {
      method: 'POST',
    }));
  } catch (error) {
    status.setKey('actionError', errorMessage(error, 'The deliberation could not be cancelled.'));
  } finally {
    status.setKey('action', '');
  }
};

export {
  cancel,
  configure,
  detail,
  draft,
  items,
  load,
  loadDetail,
  query,
  save,
  setDraftField,
  start,
  status,
};
