<script lang="ts">
	/*
	 * The blueprint library: every saved definition as a table row.
	 *
	 * A table rather than the provider workbench's cards, because blueprints
	 * are compared against each other — which model, how many tools, what
	 * iteration ceiling — and columns make that scannable.
	 */
	import Avatar from "../shared/Avatar.svelte";
	import EmptyState from "../shared/EmptyState.svelte";
	import ErrorState from "../shared/ErrorState.svelte";
	import SearchToolbar from "../shared/SearchToolbar.svelte";
	import { blueprints } from "../../stores/catalog";
	import { filteredBlueprints, loadWorkbench, query, setQuery, status } from "../../stores/blueprints";
</script>

<section class="blueprints-page">
	<header class="page-heading workbench-heading">
		<div>
			<div class="eyebrow">Build</div>
			<h1>Blueprints</h1>
			<p>Reusable definitions for agent behavior, models, and capabilities.</p>
		</div>
		<a class="button primary" href="/blueprints/new"><span aria-hidden="true">+</span> New blueprint</a>
	</header>

	<SearchToolbar
		bind:value={$query}
		label="Search blueprints"
		placeholder="Search blueprints…"
		count={$status.loading ? "Loading" : `${$filteredBlueprints.length} of ${$blueprints.length}`}
	/>

	{#if $status.error}
		<ErrorState title="Blueprints unavailable" message={$status.error} onretry={() => loadWorkbench("library")} />
	{:else if $status.loading}
		<div class="blueprint-table blueprint-loading" aria-label="Loading blueprints">
			<div class="blueprint-table-head">
				<span>Name</span><span>Provider / model</span><span>Tools</span><span>Iterations</span><span></span>
			</div>
			{#each [1, 2, 3] as _}
				<div class="blueprint-row">
					<span class="table-skeleton long"></span><span class="table-skeleton"></span><span class="table-skeleton short"></span><span class="table-skeleton short"></span><span></span>
				</div>
			{/each}
		</div>
	{:else if $blueprints.length === 0}
		<EmptyState
			kicker="Your blueprint library is empty"
			title="Create the first agent definition"
			description="Choose a provider and model, write its core instructions, then decide which tools it can use."
		>
			{#snippet mark()}
				<div class="blueprint-glyph"><span></span><span></span><span></span><span></span></div>
			{/snippet}
			{#snippet action()}
				<a class="button primary" href="/blueprints/new">Create blueprint</a>
			{/snippet}
		</EmptyState>
	{:else if $filteredBlueprints.length === 0}
		<EmptyState
			compact
			title="No matching blueprints"
			description="Try a name, purpose, provider, or model."
		>
			{#snippet mark()}<div class="empty-search">?</div>{/snippet}
			{#snippet action()}
				<button class="button secondary" type="button" onclick={() => setQuery("")}>Clear search</button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="blueprint-table">
			<div class="blueprint-table-head">
				<span>Name</span><span>Provider / model</span><span>Tools</span><span>Iterations</span><span></span>
			</div>
			{#each $filteredBlueprints as blueprint}
				<a class="blueprint-row" href={`/blueprints/edit?id=${encodeURIComponent(blueprint.id)}`}>
					<div class="blueprint-identity">
						<Avatar kind="blueprint" seed={`blueprint:${blueprint.id}`} label={blueprint.id} size={35} />
						<div><strong>{blueprint.id}</strong><span>{blueprint.description}</span></div>
					</div>
					<div class="provider-model">
						<strong>{blueprint.config.modelId}</strong><span>{blueprint.config.providerId}</span>
					</div>
					<div class="tool-summary">
						<strong>{blueprint.coreTools.length + blueprint.lazyLoadedTools.length}</strong>
						<span>{blueprint.coreTools.length} core · {blueprint.lazyLoadedTools.length} lazy</span>
					</div>
					<div class="iteration-value">
						<strong>{blueprint.config.maxIterations}</strong><span>max turns</span>
					</div>
					<span class="row-arrow" aria-hidden="true">→</span>
				</a>
			{/each}
		</div>
	{/if}
</section>

<style>

	.blueprint-table {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 0 0 8px 8px;
		overflow: hidden;
	}
	/* Head and row share a track definition so columns stay aligned. */
	.blueprint-table-head,
	.blueprint-row {
		display: grid;
		grid-template-columns: minmax(250px, 1.5fr) minmax(180px, 1fr) minmax(135px, .7fr) 100px 28px;
		align-items: center;
		column-gap: 20px;
	}
	.blueprint-table-head {
		min-height: 37px;
		padding: 0 16px;
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: .075em;
		text-transform: uppercase;
	}
	.blueprint-row {
		min-height: 77px;
		padding: 11px 16px;
		border-bottom: 1px solid var(--border);
		transition: background 120ms ease;
	}
	.blueprint-row:last-child { border-bottom: 0; }
	a.blueprint-row:hover { background: var(--surface-hover); }
	.blueprint-loading .blueprint-row { min-height: 77px; }

	.blueprint-identity {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 11px;
	}
	.blueprint-identity > div:last-child { min-width: 0; }
	.blueprint-identity strong,
	.blueprint-identity span,
	.provider-model strong,
	.provider-model span,
	.tool-summary strong,
	.tool-summary span,
	.iteration-value strong,
	.iteration-value span { display: block; }
	.blueprint-identity strong,
	.provider-model strong {
		overflow: hidden;
		font-size: 12px;
		font-weight: 580;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.blueprint-identity span {
		max-width: 430px;
		margin-top: 3px;
		overflow: hidden;
		color: var(--muted);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-model span,
	.tool-summary span,
	.iteration-value span {
		margin-top: 3px;
		color: var(--muted);
		font-size: 9px;
	}
	.tool-summary strong,
	.iteration-value strong {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 540;
	}

	.row-arrow {
		color: var(--muted);
		font-size: 15px;
		transition: transform 120ms ease, color 120ms ease;
	}
	a.blueprint-row:hover .row-arrow {
		color: var(--accent);
		transform: translateX(2px);
	}

	/* Four tiles suggesting a blueprint grid; the last is dashed to read as
	   "add one". Decorative — shown on the empty library. */
	.blueprint-glyph {
		display: grid;
		grid-template-columns: 21px 21px;
		grid-template-rows: 21px 21px;
		gap: 4px;
		margin-bottom: 20px;
		padding: 12px;
		background: var(--surface-hover);
		border: 1px solid var(--border);
		border-radius: 11px;
		box-shadow: 0 12px 35px rgb(0 0 0 / 18%);
	}
	.blueprint-glyph span {
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 18%);
		border-radius: 4px;
	}
	.blueprint-glyph span:last-child {
		background: transparent;
		border-style: dashed;
	}


	/* -------------------------------------------------------- breakpoints */

	@media (max-width: 900px) {
		/* Drop the iteration column. */
		.blueprint-table-head,
		.blueprint-row { grid-template-columns: minmax(220px, 1.5fr) minmax(160px, 1fr) 95px 24px; }
		.blueprint-table-head span:nth-child(4),
		.iteration-value { display: none; }
	}

	@media (max-width: 620px) {
		/* Rows become two stacked lines with the arrow pinned right. */
		.blueprint-table-head { display: none; }
		.blueprint-table { border-radius: 0 0 8px 8px; }
		.blueprint-row {
			grid-template-columns: 1fr 22px;
			gap: 10px;
			min-height: 94px;
		}
		.blueprint-identity { grid-column: 1; }
		.provider-model {
			grid-column: 1;
			margin-left: 46px;
		}
		.tool-summary,
		.iteration-value { display: none; }
		.row-arrow {
			grid-row: 1 / 3;
			grid-column: 2;
		}
	}
</style>
