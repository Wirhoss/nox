/*
 * Session history and inspection.
 *
 * The view is a master/detail pair driven by the URL: `?session=<id>` selects
 * a session, and browser navigation must keep working, so this store owns both
 * the fetches and the history entries that point at them.
 *
 * Why the URL is the source of truth rather than a local selection: the
 * Playground and the overview both link straight to a specific session, and a
 * selection held only in component state would be lost on a back navigation.
 * `syncFromLocation` is therefore the single entry point — `openSession` and
 * `closeDetail` push history and then converge on the same load path.
 *
 * Unlike the Playground this is a read-only inspector: it takes one snapshot
 * per open and never subscribes to the event stream.
 */

import { atom, computed, map } from 'nanostores';

import { request } from '../utils/api';

import type {
  RunStatus,
  RunSummary,
  SessionListEntry,
  SessionSnapshot,
  SnapshotActivity,
} from '../utils/types';

type SessionFilters = {
  blueprint: string;
  /** `idle` covers sessions that exist but have never produced a run. */
  status: 'all' | RunStatus | 'idle';
  query: string;
};

type SessionsStatus = {
  deleting: boolean;
  /** Set while the detail pane loads, independently of the list. */
  detailLoading: boolean;
  error: string;
  loading: boolean;
  refreshing: boolean;
};

const LIST_LIMIT = 100;
/** The inspector shows the full activity trail, not the summary tail. */
const ACTIVITY_LIMIT = 500;

const IDLE_FILTERS: SessionFilters = { blueprint: 'all', query: '', status: 'all' };

const sessions = atom<SessionListEntry[]>([]);
const detail = atom<SessionSnapshot | null>(null);
/** The id in the URL, which may be set before `detail` has loaded. */
const requestedSessionId = atom<string>('');
const filters = map<SessionFilters>({ ...IDLE_FILTERS });
const status = map<SessionsStatus>({
  deleting: false,
  detailLoading: false,
  error: '',
  loading: true,
  refreshing: false,
});

const sessionBlueprints = computed(sessions, (all) =>
  [...new Set(all.map((session) => session.blueprintId))].sort());

const filteredSessions = computed([sessions, filters], (all, active) => {
  const query = active.query.trim().toLowerCase();
  return all.filter((session) => {
    if (active.blueprint !== 'all' && session.blueprintId !== active.blueprint) return false;
    if (active.status !== 'all' && active.status !== (session.latestRun?.status ?? 'idle')) return false;
    if (!query) return true;
    return [session.sessionId, session.blueprintId, session.latestRun?.modelId ?? '']
      .some((value) => value.toLowerCase().includes(query));
  });
});

const filtersActive = computed(filters, (active) =>
  active.query.trim() !== '' || active.blueprint !== 'all' || active.status !== 'all');

const totalRuns = computed(sessions, (all) => all.reduce((total, session) => total + session.runCount, 0));

const totalTokens = computed(sessions, (all) =>
  all.reduce((total, session) => total + session.usage.inputTokens + session.usage.outputTokens, 0));

const activeCount = computed(sessions, (all) =>
  all.filter((session) => session.latestRun?.status === 'running').length);

const toolCallCount = computed(detail, (current) =>
  current ? current.messages.filter((message) => message.role === 'toolCall').length : 0);

const errorCount = computed(detail, (current) =>
  current
    ? current.recentActivities.filter((activity) =>
      activity.event.type === 'error'
      || (activity.event.type === 'message'
        && activity.event.message.role === 'toolResponse'
        && activity.event.message.isError)).length
    : 0);

/**
 * Buckets the activity trail by the run that produced it.
 *
 * The gateway emits a flat, ordered stream, so a run owns every event between
 * its `runStarted` and its `runCompleted`. A `runCompleted` for a run other
 * than the active one is still attributed to its own run, which happens when
 * the stream was truncated and the opening event fell outside the window.
 */
const groupActivitiesByRun = (
  runs: RunSummary[],
  activities: SnapshotActivity[],
): Map<string, SnapshotActivity[]> => {
  const groups = new Map(runs.map((run) => [run.runId, [] as SnapshotActivity[]]));
  let activeRunId: string | null = null;

  for (const activity of activities) {
    if (activity.event.type === 'runStarted') activeRunId = activity.event.runId;
    if (activeRunId && groups.has(activeRunId)) groups.get(activeRunId)!.push(activity);
    if (activity.event.type === 'runCompleted') {
      if (groups.has(activity.event.runId) && activeRunId !== activity.event.runId) {
        groups.get(activity.event.runId)!.push(activity);
      }
      if (activeRunId === activity.event.runId) activeRunId = null;
    }
  }
  return groups;
};

const activityGroups = computed(detail, (current) =>
  current
    ? groupActivitiesByRun(current.runs, current.recentActivities)
    : new Map<string, SnapshotActivity[]>());

/* --------------------------------------------------------------- internals */

const sessionPath = (sessionId: string): string => `/api/v1/sessions/${encodeURIComponent(sessionId)}`;

/**
 * Monotonically identifies detail requests. A response may only update the
 * view while it owns the latest sequence number and its session is still the
 * one selected in the URL.
 */
let detailRequestSequence = 0;

const invalidateDetailRequest = (): void => {
  detailRequestSequence += 1;
  status.setKey('detailLoading', false);
};

/* ----------------------------------------------------------------- actions */

const loadSessions = async (): Promise<void> => {
  status.setKey('refreshing', !status.get().loading);
  status.setKey('error', '');
  try {
    sessions.set(await request<SessionListEntry[]>(`/api/v1/sessions?limit=${LIST_LIMIT}`));
  } catch (error) {
    status.setKey('error', error instanceof Error ? error.message : 'Session history could not be loaded.');
  } finally {
    status.setKey('loading', false);
    status.setKey('refreshing', false);
  }
};

const loadDetail = async (sessionId: string): Promise<void> => {
  const requestSequence = ++detailRequestSequence;
  status.setKey('detailLoading', true);
  status.setKey('error', '');
  if (detail.get()?.session.sessionId !== sessionId) detail.set(null);

  const isCurrentRequest = (): boolean =>
    requestSequence === detailRequestSequence && requestedSessionId.get() === sessionId;

  try {
    const snapshot = await request<SessionSnapshot>(`${sessionPath(sessionId)}?activityLimit=${ACTIVITY_LIMIT}`);
    if (isCurrentRequest()) detail.set(snapshot);
  } catch (error) {
    if (isCurrentRequest()) {
      detail.set(null);
      status.setKey('error', error instanceof Error ? error.message : 'The session could not be inspected.');
    }
  } finally {
    if (isCurrentRequest()) status.setKey('detailLoading', false);
  }
};

/**
 * Reconciles the view with `?session=` in the address bar.
 *
 * Called on mount and on `popstate`, so a back or forward navigation lands on
 * the same state as following the link directly.
 */
const syncFromLocation = async (): Promise<void> => {
  const sessionId = new URLSearchParams(window.location.search).get('session');
  requestedSessionId.set(sessionId ?? '');
  if (sessionId) await loadDetail(sessionId);
  else {
    invalidateDetailRequest();
    detail.set(null);
  }
};

const openSession = async (sessionId: string): Promise<void> => {
  window.history.pushState({}, '', `/sessions?session=${encodeURIComponent(sessionId)}`);
  requestedSessionId.set(sessionId);
  await loadDetail(sessionId);
};

const closeDetail = (): void => {
  window.history.pushState({}, '', '/sessions');
  requestedSessionId.set('');
  invalidateDetailRequest();
  detail.set(null);
  status.setKey('error', '');
};

const refreshSessions = async (): Promise<void> => {
  await loadSessions();
  const current = detail.get();
  if (current) await loadDetail(current.session.sessionId);
};

const deleteSession = async (): Promise<void> => {
  const current = detail.get();
  if (!current || status.get().deleting) return;
  status.setKey('deleting', true);
  status.setKey('error', '');
  const { sessionId } = current.session;
  try {
    await request<void>(sessionPath(sessionId), { method: 'DELETE' });
    sessions.set(sessions.get().filter((session) => session.sessionId !== sessionId));
    detail.set(null);
    requestedSessionId.set('');
    // Replaces rather than pushes: the deleted session must not be reachable
    // by pressing back.
    window.history.replaceState({}, '', '/sessions');
  } catch (error) {
    status.setKey('error', error instanceof Error ? error.message : 'The session could not be deleted.');
  } finally {
    status.setKey('deleting', false);
  }
};

/** See the note in `stores/logs.ts`: `bind:` on a map does not notify. */
const setFilter = <Key extends keyof SessionFilters>(key: Key, value: SessionFilters[Key]): void => {
  filters.setKey(key, value);
};

const clearFilters = (): void => {
  filters.set({ ...IDLE_FILTERS });
};

export {
  activeCount,
  activityGroups,
  detail,
  errorCount,
  filteredSessions,
  filters,
  filtersActive,
  requestedSessionId,
  sessionBlueprints,
  sessions,
  status,
  toolCallCount,
  totalRuns,
  totalTokens,
  clearFilters,
  closeDetail,
  deleteSession,
  loadDetail,
  loadSessions,
  openSession,
  refreshSessions,
  setFilter,
  syncFromLocation,
};

export type {
  SessionFilters,
  SessionsStatus,
};
