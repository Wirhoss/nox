<script lang="ts">
	/*
	 * The provider library: every configured endpoint as a card.
	 *
	 * Cards rather than the blueprint workbench's table, because a provider is
	 * described by a handful of unrelated facts (protocol, model count,
	 * credential) rather than by columns worth comparing across rows.
	 */
	import EmptyState from "../shared/EmptyState.svelte";
	import ErrorState from "../shared/ErrorState.svelte";
	import SearchToolbar from "../shared/SearchToolbar.svelte";
	import { hostLabel, prettyType } from "../../utils/validation";
	import { modelsByProvider, providers } from "../../stores/catalog";
	import {
		dismissRestartNotice,
		filteredProviders,
		loadWorkbench,
		query,
		restartNotice,
		setQuery,
		status,
	} from "../../stores/providers";
	import RestartBanner from "./RestartBanner.svelte";

	import type { Provider } from "../../utils/types";

	/**
	 * How many models to report for a provider.
	 *
	 * Discovery fills `modelsByProvider` for every provider once it settles, so
	 * the configured list is only consulted in the window before that — not as
	 * a fallback for a provider that genuinely reports none.
	 */
	const modelCount = (provider: Provider): number =>
		($modelsByProvider[provider.id] ?? provider.modelConfigs ?? []).length;
</script>

<section class="providers-page">
	<header class="page-heading workbench-heading">
		<div>
			<div class="eyebrow">Build</div>
			<h1>Providers</h1>
			<p>Model endpoints, credentials, and runtime availability.</p>
		</div>
		<a class="button primary" href="/providers/new"><span aria-hidden="true">+</span> Add provider</a>
	</header>

	{#if $restartNotice}<RestartBanner ondismiss={dismissRestartNotice} />{/if}

	<SearchToolbar
		standalone
		bind:value={$query}
		label="Search providers"
		placeholder="Search providers…"
		count={$status.loading ? "Loading" : `${$filteredProviders.length} of ${$providers.length}`}
	/>

	{#if $status.error}
		<ErrorState title="Providers unavailable" message={$status.error} onretry={() => loadWorkbench("library")} />
	{:else if $status.loading}
		<div class="provider-grid provider-loading" aria-label="Loading providers">
			{#each [1, 2, 3] as _}<div class="provider-card"><span class="table-skeleton short"></span><span class="table-skeleton long"></span><span class="table-skeleton"></span></div>{/each}
		</div>
	{:else if $providers.length === 0}
		<EmptyState
			standalone
			kicker="No model endpoints configured"
			title="Connect your first provider"
			description="Add an OpenAI-compatible local or cloud endpoint, then choose its models in a blueprint."
		>
			{#snippet mark()}
				<div class="provider-empty-mark"><span></span><span></span><span></span></div>
			{/snippet}
			{#snippet action()}
				<a class="button primary" href="/providers/new">Add provider</a>
			{/snippet}
		</EmptyState>
	{:else if $filteredProviders.length === 0}
		<EmptyState
			compact
			standalone
			title="No matching providers"
			description="Try an ID, endpoint, or provider type."
		>
			{#snippet mark()}<div class="empty-search">?</div>{/snippet}
			{#snippet action()}
				<button class="button secondary" type="button" onclick={() => setQuery("")}>Clear search</button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="provider-grid">
			{#each $filteredProviders as provider}
				<a class="provider-card" href={`/providers/edit?id=${encodeURIComponent(provider.id)}`}>
					<div class="provider-card-top">
						<span class="provider-card-mark" aria-hidden="true">{provider.id.slice(0, 2).toUpperCase()}</span>
						<span class:active={provider.status === "active"} class="provider-status"><i></i>{provider.status}</span>
					</div>
					<div class="provider-card-copy"><h2>{provider.id}</h2><p>{hostLabel(provider.baseUrl)}</p></div>
					<div class="provider-card-facts">
						<div><span>Protocol</span><strong>{prettyType(provider.type)}</strong></div>
						<div><span>Models</span><strong>{modelCount(provider)}</strong></div>
						<div><span>Credential</span><strong>{provider.hasApiKey ? "Stored" : "None"}</strong></div>
					</div>
					<span class="provider-card-action">Configure <span aria-hidden="true">→</span></span>
				</a>
			{/each}
		</div>
	{/if}
</section>

<style>
	.provider-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(250px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}
	.provider-card {
		position: relative;
		min-width: 0;
		min-height: 242px;
		padding: 17px;
		overflow: hidden;
		background: linear-gradient(145deg, rgb(20 26 22 / 97%), rgb(15 19 16 / 97%));
		border: 1px solid var(--border);
		border-radius: 8px;
		transition: border-color 130ms ease, transform 130ms ease, background 130ms ease;
	}
	a.provider-card:hover {
		background: linear-gradient(145deg, #171d18, var(--surface-raised));
		border-color: #39443c;
		transform: translateY(-1px);
	}
	/* Decorative corner glow. */
	.provider-card::after {
		position: absolute;
		top: -65px;
		right: -50px;
		width: 160px;
		height: 160px;
		background: radial-gradient(circle, rgb(105 180 134 / 7%), transparent 67%);
		content: '';
		pointer-events: none;
	}
	.provider-loading .provider-card {
		display: flex;
		min-height: 242px;
		flex-direction: column;
		gap: 28px;
		justify-content: flex-start;
	}

	.provider-card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.provider-card-mark {
		display: grid;
		width: 38px;
		height: 38px;
		place-items: center;
		background: var(--cloud-soft);
		border: 1px solid rgb(118 162 206 / 18%);
		border-radius: 8px;
		color: #91b5d6;
		font-size: 10px;
		font-weight: 700;
	}
	.provider-status {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #c98580;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: capitalize;
	}
	.provider-status i {
		display: block;
		width: 6px;
		height: 6px;
		background: var(--danger);
		border-radius: 50%;
		box-shadow: 0 0 0 3px rgb(216 120 114 / 8%);
	}
	.provider-status.active { color: #83bc97; }
	.provider-status.active i {
		background: var(--healthy);
		box-shadow: 0 0 0 3px rgb(105 180 134 / 9%);
	}

	.provider-card-copy { margin-top: 22px; }
	.provider-card-copy h2 {
		margin: 0;
		overflow: hidden;
		font-size: 15px;
		font-weight: 590;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-copy p {
		margin: 4px 0 0;
		overflow: hidden;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 9px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-facts {
		display: grid;
		grid-template-columns: 1.45fr .65fr .8fr;
		gap: 8px;
		margin-top: 19px;
		padding: 12px 0;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.provider-card-facts span,
	.provider-card-facts strong { display: block; }
	.provider-card-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.provider-card-facts strong {
		margin-top: 3px;
		overflow: hidden;
		font-size: 9px;
		font-weight: 560;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 13px;
		color: var(--secondary);
		font-size: 10px;
	}
	.provider-card-action span {
		color: var(--muted);
		font-size: 14px;
		transition: transform 120ms ease, color 120ms ease;
	}
	a.provider-card:hover .provider-card-action span {
		color: var(--accent);
		transform: translateX(2px);
	}

	/* Three offset tiles standing in for provider cards; the third is dashed
	   to read as "add one". Decorative — shown on the empty library. */
	.provider-empty-mark {
		position: relative;
		width: 58px;
		height: 52px;
		margin-bottom: 21px;
	}
	.provider-empty-mark span {
		position: absolute;
		display: block;
		width: 28px;
		height: 28px;
		background: var(--cloud-soft);
		border: 1px solid rgb(118 162 206 / 17%);
		border-radius: 7px;
	}
	.provider-empty-mark span:nth-child(1) { top: 0; left: 0; }
	.provider-empty-mark span:nth-child(2) { top: 0; right: 0; }
	.provider-empty-mark span:nth-child(3) {
		bottom: 0;
		left: 15px;
		background: var(--surface-2);
		border-style: dashed;
	}

	@media (max-width: 1120px) {
		.provider-grid { grid-template-columns: repeat(2, minmax(250px, 1fr)); }
	}
	@media (max-width: 900px) {
		.provider-grid { grid-template-columns: 1fr; }
	}
	@media (max-width: 620px) {
		.provider-card { min-height: 230px; }
	}
</style>
