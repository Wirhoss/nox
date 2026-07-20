<script lang="ts">
	/*
	 * First-run checklist: a provider, then a blueprint, then a test session.
	 *
	 * The first two steps are requirements the dashboard can verify; the third
	 * is a link, because "has been tried" is not something worth persisting.
	 */
	import { blueprints, providers } from "../../stores/catalog";
	import { setupComplete } from "../../stores/overview";

	const providerCount = $derived($providers.length);
</script>

<section class="panel setup-panel">
	<header class="panel-heading"><div><span class="panel-kicker">Workbench</span><h2>{$setupComplete ? 'Ready for the next step' : 'Finish local setup'}</h2></div><span class:complete={$setupComplete} class="setup-count">{$setupComplete ? '2/2 ready' : `${Number(providerCount > 0) + Number($blueprints.length > 0)}/2 ready`}</span></header>
	<div class="setup-list">
		<div class:done={providerCount > 0} class="setup-item"><div class="setup-check">{providerCount > 0 ? '✓' : '1'}</div><div><strong>Configure a provider</strong><span>{providerCount > 0 ? `${providerCount} ${providerCount === 1 ? 'provider is' : 'providers are'} configured` : 'Connect a local or cloud model backend'}</span></div><span class="setup-state">{providerCount > 0 ? 'Ready' : 'Required'}</span></div>
		<div class:done={$blueprints.length > 0} class="setup-item"><div class="setup-check">{$blueprints.length > 0 ? '✓' : '2'}</div><div><strong>Create a blueprint</strong><span>{$blueprints.length > 0 ? `${$blueprints.length} agent ${$blueprints.length === 1 ? 'definition' : 'definitions'} available` : 'Define instructions, tools, provider, and model'}</span></div><span class="setup-state">{$blueprints.length > 0 ? 'Ready' : 'Required'}</span></div>
		<a class="setup-item setup-link" href="/playground"><div class="setup-check">3</div><div><strong>Test in Playground</strong><span>Start a session and inspect model, tool, and permission events</span></div><span class="setup-state">Open →</span></a>
	</div>
</section>

<style>
	/* --------------------------------------------------------- setup list */

	.setup-item {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr) auto;
		min-height: 61px;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--border);
	}
	.setup-item:last-child { border-bottom: 0; }
	.setup-link { transition: background 120ms ease; }
	.setup-link:hover { background: rgb(255 255 255 / 1.5%); }
	.setup-link:hover .setup-state { color: var(--accent); }
	.setup-check {
		display: grid;
		width: 26px;
		height: 26px;
		place-items: center;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.setup-item.done .setup-check {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 20%);
		color: var(--healthy);
	}
	.setup-item strong,
	.setup-item span:not(.setup-state) { display: block; }
	.setup-item strong {
		font-size: 12px;
		font-weight: 560;
	}
	.setup-item div > span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 10px;
	}
	.setup-state {
		color: var(--muted);
		font-size: 10px;
	}
	.setup-item.done .setup-state { color: var(--healthy); }

	@media (max-width: 620px) {
		/* Drop the trailing state column; the check mark already conveys it. */
		.setup-item {
			grid-template-columns: 30px minmax(0, 1fr);
			padding: 7px 0;
		}
		.setup-state { display: none; }
	}
</style>
