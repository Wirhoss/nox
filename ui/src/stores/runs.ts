/*
 * Run history.
 *
 * A flat, read-only list of recent executions with client-side filtering. The
 * blueprint filter options are derived from the runs themselves rather than
 * from the blueprint catalog, so the dropdown only offers values that would
 * actually match something — a blueprint that has never run is not listed.
 *
 * The summary counters are computed over the full list, not the filtered one:
 * they report the state of the daemon, not of the current view.
 */

import { atom, computed, map } from 'nanostores';

import { request } from '../utils/api';

import type { Run, RunStatus } from '../utils/types';

type RunFilters = {
  blueprint: string;
  query: string;
  status: 'all' | RunStatus;
};

type RunsStatus = {
  error: string;
  loading: boolean;
  refreshing: boolean;
};

const HISTORY_LIMIT = 100;

const IDLE_FILTERS: RunFilters = { blueprint: 'all', query: '', status: 'all' };

const runs = atom<Run[]>([]);
const filters = map<RunFilters>({ ...IDLE_FILTERS });
const status = map<RunsStatus>({ error: '', loading: true, refreshing: false });

/** Blueprint ids that actually appear in the history, for the filter dropdown. */
const runBlueprints = computed(runs, (all) => [...new Set(all.map((run) => run.blueprintId))].sort());

const filteredRuns = computed([runs, filters], (all, active) => {
  const query = active.query.trim().toLowerCase();
  return all.filter((run) => {
    if (active.status !== 'all' && run.status !== active.status) return false;
    if (active.blueprint !== 'all' && run.blueprintId !== active.blueprint) return false;
    if (!query) return true;
    return [run.runId, run.sessionId, run.blueprintId, run.modelId ?? '']
      .some((value) => value.toLowerCase().includes(query));
  });
});

const runningCount = computed(runs, (all) => all.filter((run) => run.status === 'running').length);
const failedCount = computed(runs, (all) => all.filter((run) => run.status === 'failed').length);

const tokenTotal = computed(runs, (all) =>
  all.reduce((total, run) => total + run.usage.inputTokens + run.usage.outputTokens, 0));

const filtersActive = computed(filters, (active) =>
  active.query.trim() !== '' || active.status !== 'all' || active.blueprint !== 'all');

/* ----------------------------------------------------------------- actions */

const loadRuns = async (): Promise<void> => {
  status.setKey('refreshing', !status.get().loading);
  status.setKey('error', '');
  try {
    runs.set(await request<Run[]>(`/api/v1/runs?limit=${HISTORY_LIMIT}`));
  } catch {
    status.setKey('error', 'Run history could not be loaded from the Nox daemon.');
  } finally {
    status.setKey('loading', false);
    status.setKey('refreshing', false);
  }
};

/** See the note in `stores/logs.ts`: `bind:` on a map does not notify. */
const setFilter = <Key extends keyof RunFilters>(key: Key, value: RunFilters[Key]): void => {
  filters.setKey(key, value);
};

const clearFilters = (): void => {
  filters.set({ ...IDLE_FILTERS });
};

export {
  failedCount,
  filteredRuns,
  filters,
  filtersActive,
  runBlueprints,
  runningCount,
  runs,
  status,
  tokenTotal,
  clearFilters,
  loadRuns,
  setFilter,
};

export type {
  RunFilters,
  RunsStatus,
};
