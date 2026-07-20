<script lang="ts">
	/*
	 * Logs shell.
	 *
	 * The buffer, its polling, and the filter derivations live in
	 * `stores/logs.ts`; this component renders them and owns nothing but the
	 * per-row presentation helpers below.
	 */
	import { onDestroy, onMount } from 'svelte';
	import ErrorState from '../shared/ErrorState.svelte';
	import RefreshButton from '../shared/RefreshButton.svelte';
	import { formatFullTime, formatLogTime } from '../../utils/format';
	import {
		clearFilters,
		errorCount,
		filteredLogs,
		filters,
		filtersActive,
		lastUpdated,
		live,
		loadLogs,
		response,
		setFilter,
		startLogPolling,
		status,
		stopLogPolling,
		toggleLive,
		warningCount,
	} from '../../stores/logs';
	import type { LogLevel } from '../../utils/types';

	const levelLabel = (level: LogLevel) => level.toUpperCase();
	const contextEntries = (context: Record<string, unknown>) => Object.entries(context);
	/** The first couple of context keys, shown inline before the row is opened. */
	const contextPreview = (context: Record<string, unknown>) => contextEntries(context)
		.slice(0, 2)
		.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join('  ');

	onMount(startLogPolling);
	onDestroy(stopLogPolling);
</script>

<section class="logs-page">
	<header class="page-heading logs-heading">
		<div>
			<div class="eyebrow">Observe</div>
			<h1>Logs</h1>
			<p>Read structured runtime events from the current Nox process.</p>
		</div>
		<div class="page-actions">
			{#if $lastUpdated}<span class="last-updated">Updated {formatLogTime($lastUpdated.toISOString())}</span>{/if}
			<button class:active={$live} class="live-toggle" type="button" onclick={toggleLive} aria-pressed={$live}>
				<span></span>{$live ? 'Live' : 'Paused'}
			</button>
			<RefreshButton loading={$status.loading} refreshing={$status.refreshing} onrefresh={loadLogs} />
		</div>
	</header>

	{#if $status.error && !$status.loading}
		<ErrorState title="Logs unavailable" message={$status.error} onretry={loadLogs} />
	{:else}
		<div class="log-summary" aria-label="Log summary">
			<div><span>Buffered</span><strong>{$status.loading ? '—' : $response.items.length}</strong><small>of 1,000 max</small></div>
			<div><span>Warnings</span><strong class:attention={$warningCount > 0}>{$status.loading ? '—' : $warningCount}</strong><small>in current buffer</small></div>
			<div><span>Errors</span><strong class:danger={$errorCount > 0}>{$status.loading ? '—' : $errorCount}</strong><small>error + fatal</small></div>
			<div><span>Modules</span><strong>{$status.loading ? '—' : $response.modules.length}</strong><small>{$response.dropped > 0 ? `${$response.dropped} older dropped` : 'current process'}</small></div>
		</div>

		<div class="logs-shell">
			<div class="logs-toolbar">
				<label class="log-search">
					<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
					<span class="sr-only">Search logs</span>
					<input
						value={$filters.query}
						oninput={(event) => setFilter('query', event.currentTarget.value)}
						type="search"
						placeholder="Search messages and context…"
					/>
				</label>
				<div class="log-filters">
					<label><span>Level</span><select value={$filters.level} onchange={(event) => setFilter('level', event.currentTarget.value as LogLevel | 'all')}><option value="all">All levels</option><option value="trace">Trace</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option><option value="fatal">Fatal</option></select></label>
					<label><span>Module</span><select value={$filters.module} onchange={(event) => setFilter('module', event.currentTarget.value)}><option value="all">All modules</option>{#each $response.modules as module}<option value={module}>{module}</option>{/each}</select></label>
				</div>
			</div>

			<div class="log-columns" aria-hidden="true"><span>Time</span><span>Level</span><span>Module</span><span>Message</span></div>
			{#if $status.loading}
				<div class="logs-loading" aria-label="Loading logs">{#each [1, 2, 3, 4, 5, 6] as _}<div><span></span><span></span><span></span><span></span></div>{/each}</div>
			{:else if $filteredLogs.length > 0}
				<div class="log-stream">
					{#each $filteredLogs as entry (entry.id)}
						{#if contextEntries(entry.context).length > 0}
							<details class={`log-entry ${entry.level}`}>
								<summary>
									<time title={formatFullTime(entry.timestamp)}>{formatLogTime(entry.timestamp)}</time>
									<span class={`level-badge ${entry.level}`}>{levelLabel(entry.level)}</span>
									<span class="module-name">{entry.module ?? 'core'}</span>
									<span class="message"><b>{entry.message || '(no message)'}</b><code>{contextPreview(entry.context)}</code></span>
									<span class="chevron">⌄</span>
								</summary>
								<div class="context-panel"><div><span>Structured context</span><span>log #{entry.id}</span></div><pre>{JSON.stringify(entry.context, null, 2)}</pre></div>
							</details>
						{:else}
							<div class={`log-entry plain ${entry.level}`}>
								<time title={formatFullTime(entry.timestamp)}>{formatLogTime(entry.timestamp)}</time>
								<span class={`level-badge ${entry.level}`}>{levelLabel(entry.level)}</span>
								<span class="module-name">{entry.module ?? 'core'}</span>
								<span class="message"><b>{entry.message || '(no message)'}</b></span>
							</div>
						{/if}
					{/each}
				</div>
				<div class="log-foot"><span>Showing {$filteredLogs.length} of {$response.items.length} buffered entries</span><span>{$live ? 'Refreshes every 3 seconds' : 'Automatic refresh paused'}</span></div>
			{:else}
				<div class="logs-empty">
					<div class="empty-log-mark"><span></span><span></span><span></span></div>
					<h2>{$filtersActive ? 'No logs match these filters' : 'No runtime logs yet'}</h2>
					<p>{$filtersActive ? 'Try another level, module, or search term.' : 'New structured events from this Nox process will appear here.'}</p>
					{#if $filtersActive}<button class="button secondary" type="button" onclick={clearFilters}>Clear filters</button>{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.logs-heading { align-items: center; }
	.live-toggle { display: inline-flex; height: 34px; align-items: center; gap: 7px; padding: 0 10px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--muted); cursor: pointer; font-size: 10px; }
	.live-toggle span { width: 7px; height: 7px; background: var(--muted); border-radius: 50%; }
	.live-toggle.active { color: var(--healthy); }
	.live-toggle.active span { background: var(--healthy); box-shadow: 0 0 0 3px rgb(105 180 134 / 10%); animation: live-pulse 1.8s ease infinite; }
	.log-summary { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 16px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
	.log-summary > div { min-height: 68px; padding: 12px 16px; }
	.log-summary > div + div { border-left: 1px solid var(--border); }
	.log-summary span, .log-summary strong, .log-summary small { display: block; }
	.log-summary span { color: var(--muted); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
	.log-summary strong { margin-top: 2px; font-family: var(--font-mono-explicit); font-size: 17px; font-weight: 580; }
	.log-summary strong.attention { color: var(--accent-strong); }
	.log-summary strong.danger { color: var(--danger-text); }
	.log-summary small { margin-top: 1px; color: var(--muted); font-size: 9px; }
	.logs-shell { overflow: hidden; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
	.logs-toolbar { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
	.log-search { display: flex; width: min(430px, 48%); height: 34px; align-items: center; gap: 8px; padding: 0 10px; background: var(--field-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--muted); }
	.log-search:focus-within { border-color: var(--field-border-focus); }
	.log-search svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; }
	.log-search input { width: 100%; background: transparent; border: 0; outline: 0; color: var(--text); font-size: 11px; }
	.log-filters { display: flex; gap: 8px; }
	.log-filters label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
	.log-filters select { height: 34px; padding: 0 28px 0 9px; background: var(--field-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--secondary); font-size: 10px; letter-spacing: 0; text-transform: none; }
	.log-columns, .log-entry summary, .log-entry.plain { display: grid; grid-template-columns: 94px 66px 90px minmax(280px, 1fr) 24px; align-items: center; }
	.log-columns { min-width: 760px; min-height: 34px; padding: 0 12px; background: var(--surface-sunken); border-bottom: 1px solid var(--border); color: var(--muted); font-size: 9px; font-weight: 620; letter-spacing: .07em; text-transform: uppercase; }
	.log-columns span:nth-child(4) { grid-column: 4 / -1; }
	.log-stream { overflow-x: auto; }
	.log-entry { min-width: 760px; border-bottom: 1px solid var(--border); }
	.log-entry:last-child { border-bottom: 0; }
	.log-entry summary, .log-entry.plain { min-height: 48px; padding: 6px 12px; list-style: none; }
	.log-entry summary { cursor: pointer; }
	.log-entry summary::-webkit-details-marker { display: none; }
	.log-entry summary:hover, .log-entry.plain:hover { background: var(--surface-hover); }
	.log-entry.error, .log-entry.fatal { box-shadow: inset 2px 0 var(--danger); }
	.log-entry.warn { box-shadow: inset 2px 0 var(--accent); }
	.log-entry time { color: var(--muted); font-family: var(--font-mono-explicit); font-size: 9px; font-variant-numeric: tabular-nums; }
	.level-badge { width: fit-content; padding: 2px 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; color: var(--secondary); font-family: var(--font-mono-explicit); font-size: 8px; }
	.level-badge.warn { background: var(--accent-soft); border-color: rgb(208 164 92 / 18%); color: var(--accent-strong); }
	.level-badge.error, .level-badge.fatal { background: var(--danger-soft); border-color: rgb(216 120 114 / 20%); color: var(--danger-text); }
	.level-badge.debug, .level-badge.trace { color: var(--muted); }
	.module-name { color: var(--cloud); font-family: var(--font-mono-explicit); font-size: 9px; }
	.message { min-width: 0; padding-right: 12px; }
	.message b { color: var(--text); font-size: 10px; font-weight: 480; }
	.message code { display: block; overflow: hidden; margin-top: 2px; color: var(--muted); font-family: var(--font-mono-explicit); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
	.chevron { color: var(--muted); font-size: 13px; transition: transform 120ms ease; }
	details[open] .chevron { transform: rotate(180deg); }
	.context-panel { padding: 10px 14px 13px 262px; background: var(--surface-sunken); border-top: 1px solid var(--border); }
	.context-panel > div { display: flex; justify-content: space-between; margin-bottom: 7px; color: var(--muted); font-size: 8px; letter-spacing: .05em; text-transform: uppercase; }
	.context-panel pre { max-height: 260px; margin: 0; overflow: auto; padding: 10px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; color: var(--secondary); font-family: var(--font-mono-explicit); font-size: 9px; line-height: 1.55; white-space: pre-wrap; }
	.log-foot { display: flex; min-height: 38px; align-items: center; justify-content: space-between; padding: 0 12px; background: var(--surface-sunken); border-top: 1px solid var(--border); color: var(--muted); font-size: 9px; }
	.logs-loading { padding: 2px 0; }
	.logs-loading div { display: grid; grid-template-columns: 74px 50px 70px 1fr; gap: 20px; align-items: center; height: 48px; padding: 0 14px; border-bottom: 1px solid var(--border); }
	.logs-loading span { height: 7px; background: var(--surface-3); border-radius: 4px; animation: shimmer 1.5s ease infinite alternate; }
	.logs-empty { display: flex; min-height: 350px; align-items: center; justify-content: center; flex-direction: column; padding: 35px; text-align: center; }
	.empty-log-mark { display: flex; width: 42px; height: 42px; align-items: center; justify-content: center; flex-direction: column; gap: 4px; margin-bottom: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; }
	.empty-log-mark span { width: 19px; height: 2px; background: var(--muted); border-radius: 2px; }
	.empty-log-mark span:last-child { width: 12px; margin-right: 7px; }
	.logs-empty h2 { margin: 0; font-size: 16px; font-weight: 560; }
	.logs-empty p { max-width: 390px; margin: 7px 0 18px; color: var(--muted); font-size: 11px; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
	@keyframes live-pulse { 50% { opacity: .45; } }
	@keyframes shimmer { to { opacity: .45; } }
	@media (max-width: 900px) { .log-summary { grid-template-columns: repeat(2, 1fr); } .log-summary > div:nth-child(3) { border-top: 1px solid var(--border); border-left: 0; } .log-summary > div:nth-child(4) { border-top: 1px solid var(--border); } .logs-toolbar { align-items: stretch; flex-direction: column; } .log-search { width: 100%; } .log-filters { justify-content: flex-end; } }
	@media (max-width: 620px) { .logs-heading { align-items: stretch; flex-direction: column; } .logs-heading .page-actions { display: grid; grid-template-columns: 1fr 1fr; } .logs-heading .last-updated { grid-column: 1 / -1; } .log-summary > div { padding: 10px 11px; } .log-filters { display: grid; grid-template-columns: 1fr 1fr; } .log-filters label { align-items: stretch; flex-direction: column; } .log-filters select { width: 100%; } .context-panel { padding-left: 14px; } .log-foot { align-items: flex-start; flex-direction: column; justify-content: center; gap: 2px; } }
</style>
