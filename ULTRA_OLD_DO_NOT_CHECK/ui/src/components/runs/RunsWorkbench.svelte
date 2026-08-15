<script lang="ts">
	/*
	 * Runs shell.
	 *
	 * The history, its filters, and the summary counters live in
	 * `stores/runs.ts`; this component only renders the table.
	 */
	import { onMount } from 'svelte';
	import Avatar from '../shared/Avatar.svelte';
	import ErrorState from '../shared/ErrorState.svelte';
	import RefreshButton from '../shared/RefreshButton.svelte';
	import {
		formatDuration,
		formatRelativeTime as formatTime,
		formatTokens,
		shortId,
		statusLabel,
		toDate,
	} from '../../utils/format';
	import {
		clearFilters,
		failedCount,
		filteredRuns,
		filters,
		filtersActive,
		loadRuns,
		runBlueprints,
		runningCount,
		runs,
		setFilter,
		status,
		tokenTotal,
	} from '../../stores/runs';
	import type { RunStatus } from '../../utils/types';

	onMount(loadRuns);
</script>

<section class="runs-page">
	<header class="page-heading runs-heading">
		<div>
			<div class="eyebrow">Observe</div>
			<h1>Runs</h1>
			<p>Inspect execution status, latency, and measured token usage.</p>
		</div>
		<RefreshButton loading={$status.loading} refreshing={$status.refreshing} onrefresh={loadRuns} />
	</header>

	{#if $status.error && !$status.loading}
		<ErrorState title="Runs unavailable" message={$status.error} onretry={loadRuns} />
	{:else}
		<div class="run-summary" aria-label="Run summary">
			<div><span class="summary-dot running"></span><strong>{$status.loading ? '—' : $runningCount}</strong><span>active now</span></div>
			<div><span class="summary-dot total"></span><strong>{$status.loading ? '—' : $runs.length}</strong><span>recent runs</span></div>
			<div><span class="summary-dot tokens"></span><strong>{$status.loading ? '—' : formatTokens($tokenTotal)}</strong><span>measured tokens</span></div>
			<div><span class="summary-dot failed"></span><strong>{$status.loading ? '—' : $failedCount}</strong><span>failed</span></div>
		</div>

		<div class="runs-shell">
			<div class="runs-toolbar">
				<label class="run-search">
					<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
					<span class="sr-only">Search runs</span>
					<input value={$filters.query} oninput={(event) => setFilter('query', event.currentTarget.value)} type="search" placeholder="Search run, session, model…" />
				</label>
				<div class="run-filters">
					<label><span>Status</span><select value={$filters.status} onchange={(event) => setFilter('status', event.currentTarget.value as RunStatus | 'all')}><option value="all">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="aborted">Aborted</option><option value="maxIterations">Limit reached</option></select></label>
					<label><span>Blueprint</span><select value={$filters.blueprint} onchange={(event) => setFilter('blueprint', event.currentTarget.value)}><option value="all">All blueprints</option>{#each $runBlueprints as blueprint}<option value={blueprint}>{blueprint}</option>{/each}</select></label>
				</div>
			</div>

			{#if $status.loading}
				<div class="runs-loading" aria-label="Loading runs">{#each [1, 2, 3, 4, 5] as _}<div><span></span><span></span><span></span><span></span></div>{/each}</div>
			{:else if $filteredRuns.length > 0}
				<div class="run-table-wrap">
					<table class="run-table">
						<thead><tr><th>Status</th><th>Run</th><th>Blueprint</th><th>Model</th><th>Duration</th><th>Tokens</th><th>Started</th><th><span class="sr-only">Open</span></th></tr></thead>
						<tbody>{#each $filteredRuns as run}
							<tr>
								<td><span class:live={run.status === 'running'} class={`status-pill ${run.status}`}><i></i>{statusLabel(run.status)}</span></td>
								<td><div class="run-identity"><strong>{shortId(run.runId)}</strong><span>session {shortId(run.sessionId)}</span></div></td>
								<td><div class="blueprint-cell"><Avatar kind="blueprint" seed={`blueprint:${run.blueprintId}`} label={run.blueprintId} size={27} /><span>{run.blueprintId}</span></div></td>
								<td><code>{run.modelId ?? 'Unknown'}</code></td>
								<td class="numeric">{formatDuration(run.durationMs, run.status)}</td>
								<td class="numeric"><strong>{formatTokens(run.usage.inputTokens + run.usage.outputTokens)}</strong><span>{run.usage.cacheReadTokens > 0 ? `${formatTokens(run.usage.cacheReadTokens)} cached` : 'no cache'}</span></td>
								<td><span class="time-cell" title={toDate(run.startedAt).toLocaleString()}>{formatTime(run.startedAt)}</span></td>
								<td><a class="inspect-link" href={`/playground?session=${encodeURIComponent(run.sessionId)}`} aria-label={`Open session for run ${run.runId}`}>→</a></td>
							</tr>
						{/each}</tbody>
					</table>
				</div>
				<div class="table-foot"><span>Showing {$filteredRuns.length} of {$runs.length} recent runs</span><span>Input + output tokens; cache reads shown separately</span></div>
			{:else}
				<div class="runs-empty">
					<div class="empty-run-mark"><span></span></div>
					<h2>{$filtersActive ? 'No runs match these filters' : 'No runs yet'}</h2>
					<p>{$filtersActive ? 'Try a different status, blueprint, or search term.' : 'Start a conversation in Playground. Its executions will appear here with real timing and usage data.'}</p>
					{#if $filtersActive}<button class="button secondary" type="button" onclick={clearFilters}>Clear filters</button>{:else}<a class="button primary" href="/playground">Open Playground</a>{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.runs-heading { align-items: center; }
	.run-summary { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 16px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
	.run-summary > div { display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: 9px; min-height: 58px; padding: 0 16px; }
	.run-summary > div + div { border-left: 1px solid var(--border); }
	.run-summary strong { font-family: var(--font-mono-explicit); font-size: 15px; font-weight: 600; }
	.run-summary span:last-child { color: var(--muted); font-size: 10px; }
	.summary-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--secondary); }
	.summary-dot.running { background: var(--accent); box-shadow: 0 0 0 4px rgb(208 164 92 / 8%); }
	.summary-dot.total { background: var(--cloud); }
	.summary-dot.tokens { background: var(--healthy); }
	.summary-dot.failed { background: var(--danger); }
	.runs-shell { overflow: hidden; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
	.runs-toolbar { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
	.run-search { display: flex; width: min(380px, 42%); height: 34px; align-items: center; gap: 8px; padding: 0 10px; background: var(--field-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--muted); }
	.run-search:focus-within { border-color: var(--field-border-focus); }
	.run-search svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; }
	.run-search input { width: 100%; background: transparent; border: 0; outline: 0; color: var(--text); font-size: 11px; }
	.run-filters { display: flex; gap: 8px; }
	.run-filters label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
	.run-filters select { height: 34px; padding: 0 28px 0 9px; background: var(--field-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--secondary); font-size: 10px; text-transform: none; letter-spacing: 0; }
	.run-table-wrap { overflow-x: auto; }
	.run-table { width: 100%; min-width: 980px; border-collapse: collapse; }
	.run-table th { height: 36px; padding: 0 12px; background: var(--surface-sunken); border-bottom: 1px solid var(--border); color: var(--muted); font-size: 9px; font-weight: 620; letter-spacing: .07em; text-align: left; text-transform: uppercase; }
	.run-table td { height: 62px; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--secondary); font-size: 11px; }
	.run-table tbody tr:hover { background: var(--surface-hover); }
	.run-table tbody tr:last-child td { border-bottom: 0; }
	.status-pill { display: inline-flex; align-items: center; gap: 6px; color: var(--secondary); font-size: 10px; white-space: nowrap; }
	.status-pill i { width: 7px; height: 7px; background: var(--muted); border-radius: 50%; }
	.status-pill.completed i { background: var(--healthy); }
	.status-pill.running { color: var(--accent-strong); }
	.status-pill.running i { background: var(--accent); box-shadow: 0 0 0 3px rgb(208 164 92 / 10%); animation: pulse 1.8s ease infinite; }
	.status-pill.failed i { background: var(--danger); }
	.status-pill.aborted i, .status-pill.maxIterations i { background: var(--violet); }
	.run-identity strong, .run-identity span, .numeric strong, .numeric span { display: block; }
	.run-identity strong { color: var(--text); font-family: var(--font-mono-explicit); font-size: 10px; font-weight: 550; }
	.run-identity span, .numeric span { margin-top: 3px; color: var(--muted); font-size: 9px; }
	.blueprint-cell { display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 520; }
	.run-table code { color: var(--secondary); font-family: var(--font-mono-explicit); font-size: 10px; }
	.numeric { font-family: var(--font-mono-explicit); font-variant-numeric: tabular-nums; }
	.numeric strong { color: var(--text); font-size: 11px; font-weight: 560; }
	.time-cell { color: var(--muted); white-space: nowrap; }
	.inspect-link { display: grid; width: 27px; height: 27px; place-items: center; border: 1px solid transparent; border-radius: 5px; color: var(--muted); font-size: 15px; }
	.inspect-link:hover { background: var(--surface-3); border-color: var(--border); color: var(--accent); }
	.table-foot { display: flex; min-height: 38px; align-items: center; justify-content: space-between; padding: 0 12px; background: var(--surface-sunken); border-top: 1px solid var(--border); color: var(--muted); font-size: 9px; }
	.runs-empty { display: flex; min-height: 370px; align-items: center; justify-content: center; flex-direction: column; padding: 35px; text-align: center; }
	.empty-run-mark { display: grid; width: 42px; height: 42px; place-items: center; margin-bottom: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 50%; }
	.empty-run-mark span { width: 0; height: 0; margin-left: 3px; border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 9px solid var(--muted); }
	.runs-empty h2 { margin: 0; font-size: 16px; font-weight: 560; }
	.runs-empty p { max-width: 430px; margin: 7px 0 18px; color: var(--muted); font-size: 11px; }
	.runs-loading { padding: 5px 0; }
	.runs-loading div { display: grid; grid-template-columns: 130px 1.2fr 1fr .8fr; gap: 30px; align-items: center; height: 62px; padding: 0 14px; border-bottom: 1px solid var(--border); }
	.runs-loading span { height: 8px; background: var(--surface-3); border-radius: 5px; animation: shimmer 1.5s ease infinite alternate; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
	@keyframes pulse { 50% { opacity: .45; } }
	@keyframes shimmer { to { opacity: .45; } }
	@media (max-width: 900px) { .run-summary { grid-template-columns: repeat(2, 1fr); } .run-summary > div:nth-child(3) { border-left: 0; border-top: 1px solid var(--border); } .run-summary > div:nth-child(4) { border-top: 1px solid var(--border); } .runs-toolbar { align-items: stretch; flex-direction: column; } .run-search { width: 100%; } .run-filters { justify-content: flex-end; } }
	@media (max-width: 620px) { .runs-heading { align-items: stretch; flex-direction: column; } .runs-heading :global(.button) { width: 100%; } .run-summary > div { padding: 0 11px; } .run-filters { display: grid; grid-template-columns: 1fr 1fr; } .run-filters label { align-items: stretch; flex-direction: column; } .run-filters select { width: 100%; } .table-foot { align-items: flex-start; flex-direction: column; justify-content: center; gap: 2px; } }
</style>
