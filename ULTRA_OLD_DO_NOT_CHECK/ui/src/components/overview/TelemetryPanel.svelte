<script lang="ts">
	/*
	 * Roll-up of recent run history.
	 *
	 * Latency averages only completed runs, since a run still in flight has no
	 * duration and would otherwise drag the mean toward zero.
	 */
	import { averageLatencyMs, completedRuns, measuredTokens, runs, status } from "../../stores/overview";
</script>

<section class="panel telemetry-panel">
	<header class="panel-heading"><div><span class="panel-kicker">Observability</span><h2>Run telemetry</h2></div><a class="panel-link" href="/runs">View runs →</a></header>
	<div class="telemetry-metrics">
		<div><span>Recent runs</span><strong>{$status.loading ? '—' : $runs.length}</strong></div>
		<div><span>Measured tokens</span><strong>{$status.loading ? '—' : $measuredTokens.toLocaleString()}</strong></div>
		<div><span>Avg. latency</span><strong>{$status.loading || $completedRuns.length === 0 ? '—' : `${($averageLatencyMs / 1000).toFixed(1)}s`}</strong></div>
	</div>
	<div class="telemetry-note"><strong>{$runs.length > 0 ? 'Execution history is available' : 'Waiting for the first run'}</strong><p>{$runs.length > 0 ? 'Explore status, duration, model, and token usage for each execution.' : 'Start a Playground conversation to begin collecting local execution metrics.'}</p></div>
</section>

<style>
	/* ---------------------------------------------------------- telemetry */

	.panel-link { color: var(--muted); font-size: 10px; }
	.panel-link:hover { color: var(--accent); }
	.telemetry-metrics {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		padding: 17px 16px;
	}
	.telemetry-metrics div + div { padding-left: 14px; border-left: 1px solid var(--border); }
	.telemetry-metrics span,
	.telemetry-metrics strong { display: block; }
	.telemetry-metrics span { color: var(--muted); font-size: 9px; }
	.telemetry-metrics strong { margin-top: 5px; font-family: var(--font-mono-explicit); font-size: 16px; font-weight: 570; }
	.telemetry-note {
		padding: 11px 16px 15px;
		border-top: 1px solid var(--border);
	}
	.telemetry-note strong {
		font-size: 11px;
		font-weight: 560;
	}
	.telemetry-note p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 10px;
	}
</style>
