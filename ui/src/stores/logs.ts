/*
 * Runtime log buffer.
 *
 * The gateway keeps recent log entries in a bounded ring buffer and exposes
 * the tail; there is no stream, so this store polls. The polling is what
 * belongs here rather than in the component:
 *
 * - `live` gates the timer without tearing it down, so pausing and resuming
 *   does not shift the schedule.
 * - A tick is skipped while a request is already in flight, so a slow daemon
 *   cannot accumulate overlapping fetches.
 *
 * Filtering stays in this module too, because the counts shown in the summary
 * strip are computed over the unfiltered buffer while the table shows the
 * filtered view — keeping both derivations together makes that distinction
 * hard to get wrong.
 */

import { atom, computed, map } from 'nanostores';

import { request } from '../utils/api';

import type { LogEntry, LogLevel, LogResponse } from '../utils/types';

type LogFilters = {
  level: 'all' | LogLevel;
  module: string;
  query: string;
};

type LogStatus = {
  error: string;
  /** True only before the first response; a refresh keeps the table on screen. */
  loading: boolean;
  refreshing: boolean;
};

const POLL_INTERVAL_MS = 3_000;
const BUFFER_LIMIT = 500;

const EMPTY_RESPONSE: LogResponse = { dropped: 0, items: [], modules: [], total: 0 };
const IDLE_FILTERS: LogFilters = { level: 'all', module: 'all', query: '' };

const response = atom<LogResponse>(EMPTY_RESPONSE);
const filters = map<LogFilters>({ ...IDLE_FILTERS });
const lastUpdated = atom<Date | null>(null);
/** Whether the poll is running; the timer itself keeps ticking either way. */
const live = atom<boolean>(true);
const status = map<LogStatus>({ error: '', loading: true, refreshing: false });

const filteredLogs = computed([response, filters], (current, active) => {
  const query = active.query.trim().toLowerCase();
  return current.items.filter((entry) => {
    if (active.level !== 'all' && entry.level !== active.level) return false;
    if (active.module !== 'all' && entry.module !== active.module) return false;
    if (!query) return true;
    return entry.message.toLowerCase().includes(query)
      || (entry.module?.toLowerCase().includes(query) ?? false)
      || JSON.stringify(entry.context).toLowerCase().includes(query);
  });
});

/** Counted over the whole buffer, not the filtered view: these are totals. */
const warningCount = computed(response, (current) =>
  current.items.filter((entry) => entry.level === 'warn').length);

const errorCount = computed(response, (current) =>
  current.items.filter((entry) => entry.level === 'error' || entry.level === 'fatal').length);

const filtersActive = computed(filters, (active) =>
  active.query.trim() !== '' || active.level !== 'all' || active.module !== 'all');

/* --------------------------------------------------------------- internals */

let pollTimer: ReturnType<typeof setInterval> | null = null;

/* ----------------------------------------------------------------- actions */

const loadLogs = async (): Promise<void> => {
  // A tick that lands while the previous request is outstanding is dropped
  // rather than queued, so a slow daemon cannot build up a backlog.
  if (status.get().refreshing) return;
  status.setKey('refreshing', !status.get().loading);
  status.setKey('error', '');
  try {
    response.set(await request<LogResponse>(`/api/v1/logs?limit=${BUFFER_LIMIT}`));
    lastUpdated.set(new Date());
  } catch {
    status.setKey('error', 'Runtime logs could not be loaded from the Nox daemon.');
  } finally {
    status.setKey('loading', false);
    status.setKey('refreshing', false);
  }
};

/** Fetches once, then keeps the buffer current while `live` is set. */
const startLogPolling = (): void => {
  void loadLogs();
  stopLogPolling();
  pollTimer = setInterval(() => {
    if (live.get()) void loadLogs();
  }, POLL_INTERVAL_MS);
};

/** Releases the timer. Call from the host component's teardown. */
const stopLogPolling = (): void => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
};

const toggleLive = (): void => {
  live.set(!live.get());
};

/**
 * Updates one filter.
 *
 * Goes through `setKey` rather than `bind:` on the map: a two-way binding
 * would mutate the stored object in place and hand the same reference back to
 * `set`, which nanostores discards as unchanged, so the view would never
 * update.
 */
const setFilter = <Key extends keyof LogFilters>(key: Key, value: LogFilters[Key]): void => {
  filters.setKey(key, value);
};

const clearFilters = (): void => {
  filters.set({ ...IDLE_FILTERS });
};

export {
  errorCount,
  filteredLogs,
  filters,
  filtersActive,
  lastUpdated,
  live,
  response,
  status,
  warningCount,
  clearFilters,
  loadLogs,
  setFilter,
  startLogPolling,
  stopLogPolling,
  toggleLive,
};

export type {
  LogEntry,
  LogFilters,
  LogStatus,
};
