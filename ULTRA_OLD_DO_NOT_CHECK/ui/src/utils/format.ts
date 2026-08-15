/*
 * Display formatters shared by every workbench.
 *
 * These are presentation-only: they never throw on malformed input, because
 * they render values that arrive straight from the gateway.
 */

import type { RunStatus } from './types';

/**
 * Collapses long opaque ids (session, run, request) to a scannable width.
 *
 * Caps the result at 12 characters. The tail is kept because these ids share
 * long prefixes — dropping it would render distinct ids identically.
 */
function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-3)}` : value;
}

/**
 * Formats a timestamp for a table or list row.
 *
 * The gateway returns ISO strings in most places but second-precision epoch
 * numbers from SQLite, so values below the millisecond epoch threshold are
 * scaled up rather than rendered as 1970.
 */
function formatTime(value: string | number): string {
  const raw = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' }).format(date);
}

/** Normalises the gateway's mixed ISO / epoch-seconds timestamps to a Date. */
function toDate(value: string | number): Date {
  return new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
}

/**
 * Relative time for list rows ("5m ago"), falling back to an absolute date
 * once the value is more than a day old.
 */
function formatRelativeTime(value: string | number): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const delta = Math.max(0, Date.now() - date.getTime());
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat('en', { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' }).format(date);
}

/** Wall-clock time for live event rows, where the date is implied by context. */
function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Full date and time for a transcript message.
 *
 * Messages restored from a snapshot may have no recorded time, and a run can
 * outlive the day it started, so the year is always shown.
 */
function formatMessageTime(value: Date | null | undefined): string {
  return value && !Number.isNaN(value.getTime())
    ? new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(value)
    : 'Time unavailable';
}

/**
 * Time-of-day with milliseconds, for log rows.
 *
 * Logs are read as a stream of one process's recent output, where ordering
 * within a second matters and the date does not. Malformed values are passed
 * through so a bad timestamp is visible rather than silently rewritten.
 */
function formatLogTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en', {
      fractionalSecondDigits: 3,
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
}

/** The full date behind a log row, shown on hover. */
function formatFullTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * A run's elapsed time, scaled to the unit that keeps it readable.
 *
 * A null duration means the run has not finished, which for a running run is
 * reported as such rather than as a missing value.
 */
function formatDuration(milliseconds: number | null, status?: string): string {
  if (milliseconds === null) return status === 'running' ? 'Running' : '—';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

/** The display name of a run status; `maxIterations` is the only non-obvious one. */
function statusLabel(status: RunStatus): string {
  return {
    aborted: 'Aborted',
    completed: 'Completed',
    failed: 'Failed',
    maxIterations: 'Limit reached',
    running: 'Running',
  }[status];
}

/** Abbreviates token counts so they stay column-width in a table. */
function formatTokens(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : value.toLocaleString();
}

export {
  formatClockTime,
  formatDuration,
  formatFullTime,
  formatLogTime,
  formatMessageTime,
  formatRelativeTime,
  formatTime,
  formatTokens,
  shortId,
  statusLabel,
  toDate,
};
