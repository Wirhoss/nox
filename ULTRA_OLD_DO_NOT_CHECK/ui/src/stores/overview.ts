/*
 * Overview dashboard state.
 *
 * The dashboard is a read-only roll-up of everything else, so it fetches five
 * resources at once and derives its metrics from them. Two behaviours are
 * worth keeping out of the component:
 *
 * - The daemon reachability check gates the rest. If `/api/health/live` fails
 *   there is nothing to show, and the four inventory calls are skipped rather
 *   than left to fail one by one.
 * - Once the daemon answers, a partial failure is not fatal. Each resource is
 *   settled independently and missing ones degrade to empty, with a count of
 *   what went missing surfaced as a notice rather than an error state.
 */

import { atom, computed, map } from 'nanostores';

import { request } from '../utils/api';

import { blueprints, loadBlueprints, loadProviders, loadTools, providers } from './catalog';

import type { Run, SessionSummary } from '../utils/types';

type OverviewStatus = {
  daemonOnline: boolean;
  error: string;
  /** True only for the first load, when there is nothing on screen yet. */
  loading: boolean;
  refreshing: boolean;
};

/** How many recent sessions the dashboard lists before linking out. */
const RECENT_SESSION_LIMIT = 4;

const runs = atom<Run[]>([]);
const sessions = atom<SessionSummary[]>([]);
const lastUpdated = atom<Date | null>(null);
const status = map<OverviewStatus>({
  daemonOnline: false,
  error: '',
  loading: true,
  refreshing: false,
});

const recentSessions = computed(sessions, (all) =>
  [...all]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, RECENT_SESSION_LIMIT));

/** A provider and a blueprint are the minimum needed to run anything. */
const setupComplete = computed([providers, blueprints], (allProviders, allBlueprints) =>
  allProviders.length > 0 && allBlueprints.length > 0);

const measuredTokens = computed(runs, (all) =>
  all.reduce((total, run) => total + run.usage.inputTokens + run.usage.outputTokens, 0));

/** Only finished runs have a duration, so an average over all runs would lie. */
const completedRuns = computed(runs, (all) => all.filter((run) => run.durationMs !== null));

const averageLatencyMs = computed(completedRuns, (all) =>
  all.length > 0 ? all.reduce((total, run) => total + (run.durationMs ?? 0), 0) / all.length : 0);

/* ----------------------------------------------------------------- actions */

const refreshOverview = async (): Promise<void> => {
  status.setKey('refreshing', !status.get().loading);
  status.setKey('error', '');

  try {
    await request<{ status: string }>('/api/health/live');
    status.setKey('daemonOnline', true);
  } catch {
    status.set({
      daemonOnline: false,
      error: 'The Nox daemon could not be reached.',
      loading: false,
      refreshing: false,
    });
    return;
  }

  // The catalog loaders write their own atoms; only runs and sessions are
  // owned here, so only those two results are read back.
  const results = await Promise.allSettled([
    request<Run[]>('/api/v1/runs?limit=100'),
    request<SessionSummary[]>('/api/v1/sessions'),
    loadBlueprints(),
    loadProviders(),
    loadTools(),
  ]);

  const [runResult, sessionResult] = results;
  if (runResult?.status === 'fulfilled') runs.set(runResult.value);
  if (sessionResult?.status === 'fulfilled') sessions.set(sessionResult.value);

  const failures = results.filter((result) => result.status === 'rejected').length;
  status.setKey(
    'error',
    failures > 0
      ? `${failures} workbench ${failures === 1 ? 'resource is' : 'resources are'} temporarily unavailable.`
      : '',
  );

  lastUpdated.set(new Date());
  status.setKey('loading', false);
  status.setKey('refreshing', false);
};

export {
  averageLatencyMs,
  completedRuns,
  lastUpdated,
  measuredTokens,
  recentSessions,
  runs,
  sessions,
  setupComplete,
  status,
  refreshOverview,
};

export type {
  OverviewStatus,
};
