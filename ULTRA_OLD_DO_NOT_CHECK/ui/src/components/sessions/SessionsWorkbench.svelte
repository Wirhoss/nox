<script lang="ts">
	import { onMount } from 'svelte';
	import Avatar from '../shared/Avatar.svelte';
	import ConfirmDialog from '../shared/ConfirmDialog.svelte';
	import ErrorState from '../shared/ErrorState.svelte';
	import Markdown from '../shared/Markdown.svelte';
	import {
		formatDuration,
		formatRelativeTime as formatTime,
		formatTokens,
		shortId,
		statusLabel,
		toDate,
	} from '../../utils/format';
	import { responseText, textContent } from '../../utils/messages';
	import {
		activeCount,
		activityGroups,
		closeDetail,
		deleteSession,
		detail,
		errorCount,
		filteredSessions,
		filters,
		filtersActive,
		loadSessions,
		openSession,
		refreshSessions,
		requestedSessionId,
		sessionBlueprints,
		sessions,
		setFilter,
		status,
		syncFromLocation,
		toolCallCount,
		totalRuns,
		totalTokens,
	} from '../../stores/sessions';
	import type { RunStatus, TextMessage } from '../../utils/types';

	/** Dialog visibility is view state, so it stays out of the store. */
	let deleteOpen = $state(false);

	const confirmDelete = async () => {
		await deleteSession();
		// Closed either way: on failure the error surfaces in the page notice.
		deleteOpen = false;
	};

	const handlePopState = () => { void syncFromLocation(); };
	onMount(() => {
		window.addEventListener('popstate', handlePopState);
		void Promise.all([loadSessions(), syncFromLocation()]);
		return () => window.removeEventListener('popstate', handlePopState);
	});
</script>

<section class="sessions-page">
	{#if $detail || $status.detailLoading || $requestedSessionId}
		<header class="page-heading detail-heading">
			<div>
				<a class="back-link" href="/sessions" onclick={(event) => { event.preventDefault(); closeDetail(); }}>← Sessions</a>
				<div class="eyebrow">Observe / Session</div>
				<h1>{$detail ? shortId($detail.session.sessionId) : 'Loading session…'}</h1>
				{#if $detail}<p>Conversation context with each execution preserved as an inspectable run.</p>{/if}
			</div>
			<div class="heading-actions">
				{#if $detail}<a class="button secondary" href={`/playground?session=${encodeURIComponent($detail.session.sessionId)}`}>Open in Playground</a>{/if}
				<button class="button secondary" type="button" onclick={refreshSessions} disabled={$status.detailLoading || $status.refreshing}>Refresh</button>
				{#if $detail}<button class="button danger-outline" type="button" onclick={() => (deleteOpen = true)} disabled={$detail.isRunning} title={$detail.isRunning ? 'Stop the active run before deleting this session' : 'Delete this session'}>Delete</button>{/if}
			</div>
		</header>

		{#if $status.detailLoading && !$detail}
			<div class="detail-loading"><span></span><span></span><span></span></div>
		{:else if $status.error && !$detail}
			<ErrorState title="Session unavailable" message={$status.error} onretry={syncFromLocation} />
		{:else if $detail}
			<div class="session-meta-bar">
				<div class="blueprint-cell"><Avatar kind="blueprint" seed={`blueprint:${$detail.session.blueprintId}`} label={$detail.session.blueprintId} size={30} /><div><span>Blueprint</span><strong>{$detail.session.blueprintId}</strong></div></div>
				<div><span>Session ID</span><code>{$detail.session.sessionId}</code></div>
				<div><span>Created</span><strong title={toDate($detail.session.createdAt).toLocaleString()}>{formatTime($detail.session.createdAt)}</strong></div>
				<div><span>Last activity</span><strong title={toDate($detail.session.updatedAt).toLocaleString()}>{formatTime($detail.session.updatedAt)}</strong></div>
			</div>

			<div class="detail-grid">
				<main class="run-panel">
					<div class="panel-heading"><div><span class="panel-kicker">Execution history</span><h2>Runs in this session</h2></div><span>{$detail.runs.length} total</span></div>
					{#if $detail.activityCount > $detail.recentActivities.length}<div class="truncation-note">Showing the latest {$detail.recentActivities.length} of {$detail.activityCount} technical events.</div>{/if}
					<div class="run-stack">
						{#each $detail.runs as run, index}
							<details class="run-card" open={index === 0}>
								<summary>
									<span class={`status-dot ${run.status}`}></span>
									<div class="run-title"><strong>Run {shortId(run.runId)}</strong><span>{run.modelId ?? 'Unknown model'} · {formatTime(run.startedAt)}</span></div>
									<div class="run-metric"><strong>{formatDuration(run.durationMs, run.status)}</strong><span>{statusLabel(run.status)}</span></div>
									<div class="run-metric"><strong>{formatTokens(run.usage.inputTokens + run.usage.outputTokens)}</strong><span>tokens</span></div>
									<span class="disclosure">⌄</span>
								</summary>
								<div class="run-body">
									<div class="run-usage-row"><span>Input <strong>{run.usage.inputTokens.toLocaleString()}</strong></span><span>Output <strong>{run.usage.outputTokens.toLocaleString()}</strong></span><span>Cache read <strong>{run.usage.cacheReadTokens.toLocaleString()}</strong></span><code>{run.runId}</code></div>
									<div class="event-timeline">
										{#each $activityGroups.get(run.runId) ?? [] as activity}
											{@const event = activity.event}
											{#if event.type === 'message'}
												{@const message = event.message}
												<div class:error={message.role === 'toolResponse' && message.isError} class:tool={message.role === 'toolCall' || message.role === 'toolResponse'} class="event-row">
													<span class="event-time">{toDate(activity.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
													<div>
														{#if message.role === 'toolCall'}<span class="event-kind">Tool call</span><strong>{message.name}</strong><pre>{JSON.stringify(message.arguments, null, 2)}</pre>
														{:else if message.role === 'toolResponse'}<span class="event-kind">{message.isError ? 'Tool error' : message.execution === 'deferredAck' ? 'Deferred tool accepted' : message.execution === 'deferredResult' ? 'Deferred result' : 'Tool response'}</span><strong>{message.name}</strong><pre>{responseText(message) || 'No textual output'}</pre>
														{:else}<span class="event-kind">{message.role}</span><div class="message-content"><Markdown source={textContent(message)} /></div>{/if}
													</div>
												</div>
											{:else if event.type === 'permissionRequest'}
												<div class="event-row attention"><span class="event-time">{toDate(activity.receivedAt).toLocaleTimeString()}</span><div><span class="event-kind">Permission requested</span><strong>{event.toolName}</strong><p>{event.reason}</p><pre>{JSON.stringify(event.toolArguments, null, 2)}</pre></div></div>
											{:else if event.type === 'permissionResolved'}
												<div class="event-row"><span class="event-time">{toDate(activity.receivedAt).toLocaleTimeString()}</span><div><span class="event-kind">Permission</span><strong>{event.resolution}</strong></div></div>
											{:else if event.type === 'error'}
												<div class="event-row error"><span class="event-time">{toDate(activity.receivedAt).toLocaleTimeString()}</span><div><span class="event-kind">Run error</span><strong>{event.message}</strong></div></div>
											{/if}
										{:else}<div class="empty-events">No persisted step events for this run.</div>{/each}
									</div>
								</div>
							</details>
						{:else}<div class="empty-runs"><h3>No runs yet</h3><p>This session has not executed a model turn.</p></div>{/each}
					</div>
				</main>

				<aside class="session-inspector">
					<div class="panel-heading"><div><span class="panel-kicker">Session totals</span><h2>Context</h2></div></div>
					<div class="fact-grid"><div><span>Messages</span><strong>{$detail.messages.length}</strong></div><div><span>Runs</span><strong>{$detail.runs.length}</strong></div><div><span>Tool calls</span><strong>{$toolCallCount}</strong></div><div><span>Errors</span><strong class:danger={$errorCount > 0}>{$errorCount}</strong></div></div>
					<div class="usage-card"><div><span>Total measured</span><strong>{formatTokens($detail.runs.reduce((sum, run) => sum + run.usage.inputTokens + run.usage.outputTokens, 0))} tokens</strong></div><div><span>Input</span><strong>{$detail.runs.reduce((sum, run) => sum + run.usage.inputTokens, 0).toLocaleString()}</strong></div><div><span>Output</span><strong>{$detail.runs.reduce((sum, run) => sum + run.usage.outputTokens, 0).toLocaleString()}</strong></div><div><span>Cache read</span><strong>{$detail.runs.reduce((sum, run) => sum + run.usage.cacheReadTokens, 0).toLocaleString()}</strong></div></div>
					<div class="prompt-index"><span class="panel-kicker">User turns</span>{#each $detail.messages.filter((message): message is Extract<TextMessage, { role: 'user' }> => message.role === 'user') as message, index}<div><span>{index + 1}</span><p>{textContent(message)}</p></div>{:else}<p class="muted">No user messages.</p>{/each}</div>
				</aside>
			</div>
		{/if}
	{:else}
		<header class="page-heading sessions-heading">
			<div><div class="eyebrow">Observe</div><h1>Sessions</h1><p>Inspect complete conversations, then drill into each model run, tool call, and response.</p></div>
			<button class="button secondary" type="button" onclick={refreshSessions} disabled={$status.loading || $status.refreshing}>{$status.refreshing ? 'Refreshing' : 'Refresh'}</button>
		</header>

		{#if $status.error && !$status.loading}<ErrorState title="Sessions unavailable" message={$status.error} onretry={loadSessions} />
		{:else}
			<div class="session-summary"><div><span class="summary-dot running"></span><strong>{$status.loading ? '—' : $activeCount}</strong><span>active now</span></div><div><span class="summary-dot total"></span><strong>{$status.loading ? '—' : $sessions.length}</strong><span>recent sessions</span></div><div><span class="summary-dot runs"></span><strong>{$status.loading ? '—' : $totalRuns}</strong><span>model runs</span></div><div><span class="summary-dot tokens"></span><strong>{$status.loading ? '—' : formatTokens($totalTokens)}</strong><span>measured tokens</span></div></div>
			<div class="sessions-shell">
				<div class="sessions-toolbar"><label class="session-search"><span class="sr-only">Search sessions</span><input value={$filters.query} oninput={(event) => setFilter('query', event.currentTarget.value)} type="search" placeholder="Search session, blueprint, model…" /></label><div class="session-filters"><label><span>Status</span><select value={$filters.status} onchange={(event) => setFilter('status', event.currentTarget.value as RunStatus | 'all' | 'idle')}><option value="all">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="aborted">Aborted</option><option value="maxIterations">Limit reached</option><option value="idle">No runs</option></select></label><label><span>Blueprint</span><select value={$filters.blueprint} onchange={(event) => setFilter('blueprint', event.currentTarget.value)}><option value="all">All blueprints</option>{#each $sessionBlueprints as blueprint}<option value={blueprint}>{blueprint}</option>{/each}</select></label></div></div>
				{#if $status.loading}<div class="sessions-loading">{#each [1,2,3,4,5] as _}<div><span></span><span></span><span></span></div>{/each}</div>
				{:else if $filteredSessions.length}
					<div class="session-list">{#each $filteredSessions as session}<a href={`/sessions?session=${encodeURIComponent(session.sessionId)}`} onclick={(event) => { event.preventDefault(); openSession(session.sessionId); }}><div class="session-primary"><Avatar kind="blueprint" seed={`blueprint:${session.blueprintId}`} label={session.blueprintId} size={34} /><div><strong>{session.blueprintId}</strong><code>{shortId(session.sessionId)}</code></div></div><div class="session-status"><span class={`status-dot ${session.latestRun?.status ?? 'idle'}`}></span><div><strong>{session.latestRun ? statusLabel(session.latestRun.status) : 'No runs'}</strong><span>{session.latestRun?.modelId ?? 'Session ready'}</span></div></div><div class="session-stat"><strong>{session.runCount}</strong><span>runs</span></div><div class="session-stat"><strong>{formatTokens(session.usage.inputTokens + session.usage.outputTokens)}</strong><span>tokens</span></div><div class="session-time"><strong>{formatTime(session.updatedAt)}</strong><span>last activity</span></div><span class="open-arrow">→</span></a>{/each}</div>
					<div class="table-foot"><span>Showing {$filteredSessions.length} of {$sessions.length} recent sessions</span><span>Runs remain available inside each session</span></div>
				{:else}<div class="sessions-empty"><h2>{$filtersActive ? 'No sessions match these filters' : 'No sessions yet'}</h2><p>Start a conversation in Playground. Its full execution history will appear here.</p><a class="button primary" href="/playground">Open Playground</a></div>{/if}
			</div>
		{/if}
	{/if}

	{#if deleteOpen && $detail}
		<ConfirmDialog
			title="Delete this session?"
			confirmLabel="Delete session"
			busyLabel="Deleting…"
			busy={$status.deleting}
			onconfirm={confirmDelete}
			oncancel={() => (deleteOpen = false)}
		>
			{#snippet description()}
				Messages, runs, tool activity, and usage history for
				<code>{shortId($detail.session.sessionId)}</code> will be permanently deleted.
			{/snippet}
		</ConfirmDialog>
	{/if}
</section>

<style>
	.sessions-heading,.detail-heading{align-items:center}.heading-actions{display:flex;gap:8px}.back-link{display:inline-block;margin-bottom:10px;color:var(--muted);font-size:11px}.back-link:hover{color:var(--accent)}
	.session-summary{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:16px;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.session-summary>div{display:grid;grid-template-columns:auto auto 1fr;min-height:58px;align-items:center;gap:9px;padding:0 16px}.session-summary>div+div{border-left:1px solid var(--border)}.session-summary strong{font-family:var(--font-mono-explicit);font-size:15px}.session-summary span:last-child{color:var(--muted);font-size:10px}.summary-dot{width:7px;height:7px;border-radius:50%;background:var(--secondary)}.summary-dot.running{background:var(--accent)}.summary-dot.total{background:var(--cloud)}.summary-dot.runs{background:var(--violet)}.summary-dot.tokens{background:var(--healthy)}
	.sessions-shell,.run-panel,.session-inspector{overflow:hidden;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.sessions-toolbar{display:flex;min-height:58px;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;border-bottom:1px solid var(--border)}.session-search{width:min(410px,44%)}.session-search input{width:100%;height:34px;padding:0 11px;background:var(--field-bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px}.session-search input:focus{border-color:var(--field-border-focus);outline:0}.session-filters{display:flex;gap:8px}.session-filters label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.session-filters select{height:34px;padding:0 28px 0 9px;background:var(--field-bg);border:1px solid var(--border);border-radius:6px;color:var(--secondary);font-size:10px;text-transform:none;letter-spacing:0}
	.session-list>a{display:grid;grid-template-columns:minmax(230px,1.4fr) minmax(170px,1fr) 75px 90px 115px 28px;min-height:70px;align-items:center;gap:16px;padding:9px 14px;border-bottom:1px solid var(--border);color:var(--secondary)}.session-list>a:last-child{border-bottom:0}.session-list>a:hover{background:var(--surface-hover)}.session-primary,.session-status{display:flex;align-items:center;gap:10px;min-width:0}.session-primary strong,.session-primary code,.session-status strong,.session-status span,.session-stat strong,.session-stat span,.session-time strong,.session-time span{display:block}.session-primary strong{color:var(--text);font-size:12px}.session-primary code{margin-top:3px;color:var(--muted);font-size:9px}.session-status strong{color:var(--text);font-size:10px}.session-status span,.session-stat span,.session-time span{margin-top:3px;color:var(--muted);font-size:9px}.session-stat strong,.session-time strong{color:var(--text);font-family:var(--font-mono-explicit);font-size:11px}.open-arrow{color:var(--muted);font-size:15px}.status-dot{display:block;width:8px;height:8px;flex:0 0 auto;background:var(--muted);border-radius:50%}.status-dot.completed{background:var(--healthy)}.status-dot.running{background:var(--accent);box-shadow:0 0 0 3px rgb(208 164 92 / 10%)}.status-dot.failed{background:var(--danger)}.status-dot.aborted,.status-dot.maxIterations{background:var(--violet)}
	.table-foot{display:flex;min-height:38px;align-items:center;justify-content:space-between;padding:0 12px;background:var(--surface-sunken);border-top:1px solid var(--border);color:var(--muted);font-size:9px}.sessions-empty,.error-state{display:flex;min-height:340px;align-items:center;justify-content:center;flex-direction:column;padding:32px;text-align:center}.sessions-empty h2{margin:0;font-size:16px}.sessions-empty p{margin:7px 0 18px;color:var(--muted);font-size:11px}.sessions-loading{padding:5px 0}.sessions-loading div{display:grid;grid-template-columns:1.5fr 1fr .6fr;gap:30px;align-items:center;height:70px;padding:0 14px;border-bottom:1px solid var(--border)}.sessions-loading span,.detail-loading span{height:9px;background:var(--surface-3);border-radius:5px}.detail-loading{display:grid;gap:14px}.detail-loading span{height:100px}
	.session-meta-bar{display:grid;grid-template-columns:1.1fr 1.6fr .7fr .7fr;align-items:center;gap:20px;margin-bottom:16px;padding:13px 16px;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.session-meta-bar>div>span,.blueprint-cell div span{display:block;margin-bottom:4px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.07em}.session-meta-bar strong,.session-meta-bar code{color:var(--text);font-size:10px}.session-meta-bar code{word-break:break-all}.blueprint-cell{display:flex;align-items:center;gap:10px}.blueprint-cell div strong{font-size:12px}
	.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;align-items:start;gap:16px}.panel-heading{display:flex;min-height:66px;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--border)}.panel-heading h2{margin:3px 0 0;font-size:15px;font-weight:570}.panel-heading>span{color:var(--muted);font-size:10px}.panel-kicker{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.09em}.truncation-note{padding:9px 16px;background:var(--accent-soft);border-bottom:1px solid var(--border);color:var(--accent-strong);font-size:9px}.run-card{border-bottom:1px solid var(--border)}.run-card:last-child{border-bottom:0}.run-card>summary{display:grid;grid-template-columns:auto minmax(190px,1fr) 90px 80px auto;align-items:center;gap:12px;min-height:72px;padding:9px 16px;cursor:pointer;list-style:none}.run-card>summary::-webkit-details-marker{display:none}.run-card>summary:hover{background:var(--surface-hover)}.run-title strong,.run-title span,.run-metric strong,.run-metric span{display:block}.run-title strong{color:var(--text);font-family:var(--font-mono-explicit);font-size:10px}.run-title span,.run-metric span{margin-top:4px;color:var(--muted);font-size:9px}.run-metric{text-align:right}.run-metric strong{color:var(--text);font-family:var(--font-mono-explicit);font-size:10px}.disclosure{color:var(--muted);transition:transform 150ms}.run-card[open] .disclosure{transform:rotate(180deg)}.run-body{background:var(--surface-sunken);border-top:1px solid var(--border)}.run-usage-row{display:flex;align-items:center;gap:18px;min-height:38px;padding:6px 16px;border-bottom:1px solid var(--border);color:var(--muted);font-size:9px}.run-usage-row strong{margin-left:3px;color:var(--secondary)}.run-usage-row code{margin-left:auto;color:var(--muted);font-size:8px}.event-timeline{padding:8px 0}.event-row{display:grid;grid-template-columns:72px 1fr;gap:10px;padding:8px 16px;border-left:2px solid transparent}.event-row.tool{border-left-color:var(--violet)}.event-row.error{border-left-color:var(--danger);background:rgb(190 82 82 / 5%)}.event-row.attention{border-left-color:var(--accent)}.event-time{padding-top:2px;color:var(--muted);font-family:var(--font-mono-explicit);font-size:8px}.event-row>div>strong,.event-kind{display:block}.event-kind{margin-bottom:3px;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.07em}.event-row>div>strong{color:var(--text);font-size:10px}.event-row p{margin:4px 0;color:var(--secondary);font-size:10px}.event-row pre{overflow:auto;max-height:280px;margin:7px 0 0;padding:10px;background:var(--surface-1);border:1px solid var(--border);border-radius:5px;color:var(--secondary);font-size:9px;white-space:pre-wrap;word-break:break-word}.message-content{color:var(--secondary);font-size:11px}.empty-events,.empty-runs{padding:28px;color:var(--muted);font-size:10px;text-align:center}.empty-runs h3{margin:0;color:var(--text)}.empty-runs p{margin:5px 0 0}
	.session-inspector{position:sticky;top:calc(var(--topbar-height) + 16px)}.fact-grid{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)}.fact-grid>div{padding:14px 16px}.fact-grid>div:nth-child(odd){border-right:1px solid var(--border)}.fact-grid>div:nth-child(-n+2){border-bottom:1px solid var(--border)}.fact-grid span,.fact-grid strong{display:block}.fact-grid span{color:var(--muted);font-size:9px}.fact-grid strong{margin-top:4px;font-family:var(--font-mono-explicit);font-size:14px}.danger{color:var(--danger)}.usage-card{padding:10px 16px;border-bottom:1px solid var(--border)}.usage-card>div{display:flex;justify-content:space-between;padding:5px 0;color:var(--muted);font-size:9px}.usage-card>div:first-child{margin-bottom:5px;padding-bottom:10px;border-bottom:1px solid var(--border);color:var(--secondary)}.usage-card strong{color:var(--text);font-family:var(--font-mono-explicit);font-weight:560}.prompt-index{padding:16px}.prompt-index>.panel-kicker{display:block;margin-bottom:9px}.prompt-index>div{display:grid;grid-template-columns:20px 1fr;gap:8px;padding:7px 0;border-top:1px solid var(--border)}.prompt-index>div>span{display:grid;width:18px;height:18px;place-items:center;background:var(--surface-3);border-radius:50%;color:var(--muted);font-size:8px}.prompt-index p{display:-webkit-box;overflow:hidden;margin:2px 0;color:var(--secondary);font-size:9px;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3}.muted{color:var(--muted)!important}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
	@media(max-width:1050px){.detail-grid{grid-template-columns:1fr}.session-inspector{position:static}.session-list>a{grid-template-columns:minmax(220px,1.4fr) minmax(160px,1fr) 70px 90px 28px}.session-time{display:none}}
	@media(max-width:760px){.session-summary{grid-template-columns:repeat(2,1fr)}.session-summary>div:nth-child(3){border-left:0;border-top:1px solid var(--border)}.session-summary>div:nth-child(4){border-top:1px solid var(--border)}.sessions-toolbar,.detail-heading{align-items:stretch;flex-direction:column}.session-search{width:100%}.session-list>a{grid-template-columns:1fr auto auto}.session-status,.session-stat:nth-of-type(2),.session-time{display:none}.session-meta-bar{grid-template-columns:1fr 1fr}.detail-grid{display:block}.session-inspector{margin-top:16px}.run-card>summary{grid-template-columns:auto 1fr auto}.run-metric:nth-of-type(2),.run-metric:nth-of-type(3){display:none}.heading-actions{width:100%}.heading-actions>*{flex:1}.run-usage-row{align-items:flex-start;flex-wrap:wrap}.run-usage-row code{width:100%;margin:0}.event-row{grid-template-columns:1fr}.event-time{padding:0}.session-filters{display:grid;grid-template-columns:1fr 1fr}.session-filters label{align-items:stretch;flex-direction:column}.session-filters select{width:100%}}
</style>
