<script lang="ts">
	import { currentSession, messageCounts, permissions, run, stream } from "../../stores/playground";
	import { shortId } from "../../utils/format";
	import ActivityTimeline from "./ActivityTimeline.svelte";

	const connected = $derived($stream.connection === "connected");

	const headline = $derived(
		$run.active
			? ($permissions.length > 0 ? "Permission required" : "Agent responding")
			: $run.status
				? `Run ${$run.status}`
				: $currentSession ? "Session idle" : "Not started",
	);

	const detail = $derived(
		$run.active
			? `${$run.elapsedSeconds}s elapsed`
			: $run.durationMs
				? `${Math.round($run.durationMs)} ms · ${connected ? "stream connected" : "stream offline"}`
				: connected ? "Event stream connected" : "No active event stream",
	);

	const totalTokens = $derived($run.usage.inputTokens + $run.usage.outputTokens);
</script>

<aside class="playground-inspector">
	<div class="playground-panel-head inspector-head">
		<span class="panel-kicker">Inspector</span>
		<h2>Current run</h2>
	</div>

	<div class="run-status-card">
		<div class="run-status-main">
			<span class="run-status-dot" class:active={$run.active}></span>
			<div>
				<strong>{headline}</strong>
				<span>{detail}</span>
			</div>
		</div>
		{#if $run.runId}
			<code>Run {shortId($run.runId)}</code>
		{:else if $currentSession}
			<code>Session {shortId($currentSession.sessionId)}</code>
		{/if}
	</div>

	<div class="run-facts">
		<div><span>Messages</span><strong>{$messageCounts.total}</strong></div>
		<div><span>Responses</span><strong>{$messageCounts.assistant}</strong></div>
		<div><span>Tool calls</span><strong>{$messageCounts.toolCalls}</strong></div>
	</div>

	<div class="run-usage">
		<div class="run-usage-head">
			<span>Last measured usage</span>
			<strong>{totalTokens} tokens</strong>
		</div>
		<div><span>Input</span><strong>{$run.usage.inputTokens.toLocaleString()}</strong></div>
		<div><span>Output</span><strong>{$run.usage.outputTokens.toLocaleString()}</strong></div>
		<div><span>Cache read</span><strong>{$run.usage.cacheReadTokens.toLocaleString()}</strong></div>
	</div>

	{#if $permissions.length > 0}
		<div class="inspector-attention">
			<span>!</span>
			<div>
				<strong>Run paused</strong>
				<p>A protected tool is waiting for your decision.</p>
			</div>
		</div>
	{/if}

	<ActivityTimeline />

	<div class="inspector-contract">
		<strong>Run-local measurements</strong>
		<p>Usage reflects provider-reported tokens for the latest completed run. Cost estimation is not configured.</p>
	</div>
</aside>

<style>
	.playground-inspector {
		min-width: 0;
		overflow-y: auto;
		background: rgb(16 20 17 / 90%);
		border-left: 1px solid var(--border);
	}
	.playground-panel-head {
		min-height: 66px;
		padding: 16px;
		border-bottom: 1px solid var(--border);
	}
	.playground-panel-head h2 {
		margin: 3px 0 0;
		font-size: 13px;
		font-weight: 580;
	}

	.run-status-card {
		padding: 14px 15px;
		border-bottom: 1px solid var(--border);
	}
	.run-status-main {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.run-status-main > div { min-width: 0; }
	.run-status-dot {
		width: 8px;
		height: 8px;
		flex: 0 0 auto;
		background: var(--muted);
		border-radius: 50%;
	}
	.run-status-dot.active {
		background: var(--healthy);
		box-shadow: 0 0 0 4px rgb(105 180 134 / 9%);
		animation: status-pulse 1.5s ease infinite;
	}
	.run-status-main strong,
	.run-status-main span { display: block; }
	.run-status-main strong {
		font-size: 10px;
		font-weight: 580;
	}
	.run-status-main span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	/* Aligned under the status text, past the dot. */
	.run-status-card code {
		display: block;
		margin: 11px 0 0 17px;
		padding-top: 9px;
		border-top: 1px solid var(--border);
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}

	.run-facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		padding: 8px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.run-facts > div { padding: 7px 0; }
	.run-facts span,
	.run-facts strong { display: block; }
	.run-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.run-facts strong {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 540;
	}

	.run-usage {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		padding: 10px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.run-usage-head {
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		color: var(--muted);
		font-size: 8px;
	}
	.run-usage-head strong {
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 550;
	}
	.run-usage > div:not(.run-usage-head) span,
	.run-usage > div:not(.run-usage-head) strong { display: block; }
	.run-usage > div:not(.run-usage-head) span {
		color: var(--muted);
		font-size: 7px;
	}
	.run-usage > div:not(.run-usage-head) strong {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
	}

	.inspector-attention {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		margin: 12px;
		padding: 10px;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 16%);
		border-radius: 6px;
	}
	.inspector-attention > span {
		display: grid;
		width: 19px;
		height: 19px;
		flex: 0 0 auto;
		place-items: center;
		border: 1px solid rgb(208 164 92 / 30%);
		border-radius: 50%;
		color: var(--accent);
		font-size: 8px;
		font-weight: 700;
	}
	.inspector-attention strong {
		font-size: 9px;
		font-weight: 580;
	}
	.inspector-attention p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	.inspector-contract {
		margin: 16px 12px;
		padding: 10px;
		background: #131714;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.inspector-contract strong {
		display: block;
		color: var(--secondary);
		font-size: 8px;
		font-weight: 570;
	}
	.inspector-contract p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 7px;
		line-height: 1.5;
	}

	/* Below this width the inspector drops out of the right column and becomes
	   a horizontal strip under the conversation, keeping only the essentials. */
	@media (max-width: 1120px) {
		.playground-inspector {
			display: grid;
			grid-column: 1 / -1;
			grid-template-columns: 160px 1fr 1fr;
			border-top: 1px solid var(--border);
			border-left: 0;
		}
		.inspector-head { border-right: 1px solid var(--border); }
		.run-status-card {
			border-right: 1px solid var(--border);
			border-bottom: 0;
		}
		.run-facts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
		.run-usage,
		.inspector-contract { display: none; }
	}

	@media (max-width: 900px) {
		.playground-inspector { grid-template-columns: 140px 1fr; }
	}

	@media (max-width: 620px) {
		.playground-inspector { display: block; }
		.inspector-head,
		.run-status-card { border-right: 0; }
	}
</style>
