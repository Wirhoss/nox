<script lang="ts">
	import { formatTime } from "../../utils/format";
	import EmptyState from "../shared/EmptyState.svelte";
	import ErrorState from "../shared/ErrorState.svelte";
	import SearchToolbar from "../shared/SearchToolbar.svelte";

	type Item = {
		id: string;
		outcome: string;
		stage?: string;
		status: "draft" | "active" | "paused" | "completed" | "failed" | "cancelled";
		title: string;
		updatedAt: string | number;
	};
	type Copy = {
		action: string;
		description: string;
		emptyDescription: string;
		emptyKicker: string;
		emptyTitle: string;
		search: string;
		title: string;
	};
	type Props = {
		copy: Copy;
		error: string;
		itemBasePath?: string;
		items: Item[];
		loading: boolean;
		newPath: string;
		onretry: () => void;
		query: string;
		tone: "research" | "deliberation";
	};

	let { copy, error, itemBasePath, items, loading, newPath, onretry, query = $bindable(), tone }: Props = $props();

	const filtered = $derived(items.filter((item) => {
		const needle = query.trim().toLowerCase();
		return !needle || `${item.title} ${item.outcome}`.toLowerCase().includes(needle);
	}));
	const activeCount = $derived(items.filter((item) => item.status === "active").length);
	const completedCount = $derived(items.filter((item) => item.status === "completed").length);
	let createdId = $state("");
	$effect(() => {
		createdId = new URLSearchParams(window.location.search).get("created") ?? "";
	});
</script>

<section>
	<header class="page-heading workbench-heading">
		<div><div class="eyebrow">Operate</div><h1>{copy.title}</h1><p>{copy.description}</p></div>
		<a class="button primary" href={newPath}><span aria-hidden="true">+</span> {copy.action}</a>
	</header>

	<div class="activity-summary" aria-label={`${copy.title} totals`}>
		<div><span class={`metric-dot ${tone}`}></span><span>Total</span><strong>{loading ? "—" : items.length}</strong></div>
		<div><span class="metric-dot active"></span><span>Active</span><strong>{loading ? "—" : activeCount}</strong></div>
		<div><span class="metric-dot completed"></span><span>Completed</span><strong>{loading ? "—" : completedCount}</strong></div>
	</div>

	<SearchToolbar standalone bind:value={query} label={`Search ${copy.title}`} placeholder={copy.search} count={loading ? "Loading" : `${filtered.length} of ${items.length}`} />

	{#if error}
		<ErrorState title={`${copy.title} unavailable`} message={error} {onretry} />
	{:else if loading}
		<div class="activity-grid activity-loading" aria-label={`Loading ${copy.title}`}>
			{#each [1, 2, 3] as _}<div class="activity-card"><span class="table-skeleton short"></span><span class="table-skeleton long"></span><span class="table-skeleton"></span></div>{/each}
		</div>
	{:else if items.length === 0}
		<EmptyState standalone kicker={copy.emptyKicker} title={copy.emptyTitle} description={copy.emptyDescription}>
			{#snippet mark()}<div class="activity-empty-mark"><span></span><span></span><span></span></div>{/snippet}
			{#snippet action()}<a class="button primary" href={newPath}>{copy.action}</a>{/snippet}
		</EmptyState>
	{:else if filtered.length === 0}
		<EmptyState compact standalone title="No matching activities" description="Try another title, question, or outcome.">
			{#snippet mark()}<div class="empty-search">?</div>{/snippet}
			{#snippet action()}<button class="button secondary" type="button" onclick={() => (query = "")}>Clear search</button>{/snippet}
		</EmptyState>
	{:else}
		<div class="activity-section-heading"><span>{copy.title} activities</span><small>Drafts continue into team and coordination setup</small></div>
		<div class="activity-grid">
			{#each filtered as item}
				<a class:interactive={Boolean(itemBasePath)} class="activity-card-link" href={itemBasePath ? `${itemBasePath}?id=${encodeURIComponent(item.id)}` : undefined}>
				<article class:created={item.id === createdId} class={`activity-card ${tone}`}>
					<div class="activity-card-top"><span class="activity-kind"><i></i>{copy.title}</span><span class={`activity-status ${item.status}`}>{item.status}</span></div>
					<div class="activity-copy"><h2>{item.title}</h2><p>{item.outcome}</p></div>
					<div class="activity-meta"><div><span>Updated</span><strong>{formatTime(item.updatedAt)}</strong></div><div><span>Stage</span><strong>Outcome captured</strong></div></div>
					<footer><code>{item.id.slice(0, 10)}</code><span>{item.stage ?? "Outcome captured"}<b>{itemBasePath ? "→" : ""}</b></span></footer>
				</article>
				</a>
			{/each}
		</div>
	{/if}
</section>

<style>
	.activity-summary{display:flex;gap:8px;margin-bottom:12px}.activity-summary>div{display:flex;min-width:150px;height:42px;align-items:center;gap:8px;padding:0 12px;background:var(--surface-1);border:1px solid var(--border);border-radius:7px;color:var(--muted);font-size:10px}.activity-summary strong{margin-left:auto;color:var(--text);font-family:var(--font-mono-explicit);font-size:12px}.metric-dot{width:7px;height:7px;border-radius:50%}.metric-dot.research{background:var(--cloud)}.metric-dot.deliberation{background:var(--violet)}.metric-dot.active{background:var(--accent)}.metric-dot.completed{background:var(--healthy)}.activity-card-link{display:block;min-width:0;color:inherit;text-decoration:none}.activity-card-link.interactive .activity-card{cursor:pointer;transition:border-color .15s ease,transform .15s ease}.activity-card-link.interactive:hover .activity-card{border-color:rgb(170 139 194 / 34%);transform:translateY(-1px)}
	.activity-section-heading{display:flex;align-items:center;justify-content:space-between;margin:20px 2px 9px;color:var(--secondary);font-size:9px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.activity-section-heading small{color:var(--muted);font-size:8px;font-weight:450;letter-spacing:.04em}.activity-grid{display:grid;grid-template-columns:repeat(3,minmax(250px,1fr));gap:12px;margin-top:12px}.activity-section-heading+.activity-grid{margin-top:0}.activity-card{position:relative;display:flex;min-height:250px;min-width:0;flex-direction:column;padding:17px;overflow:hidden;background:linear-gradient(145deg,rgb(20 26 22 / 97%),rgb(15 19 16 / 97%));border:1px solid var(--border);border-radius:8px}.activity-card::after{position:absolute;top:-70px;right:-50px;width:170px;height:170px;background:radial-gradient(circle,rgb(118 162 206 / 8%),transparent 68%);content:"";pointer-events:none}.activity-card.deliberation::after{background:radial-gradient(circle,rgb(170 139 194 / 8%),transparent 68%)}.activity-card.created{border-color:rgb(208 164 92 / 48%);box-shadow:0 0 0 2px rgb(208 164 92 / 6%)}.activity-loading .activity-card{gap:30px;justify-content:flex-start;opacity:.75}.activity-card-top{display:flex;align-items:center;justify-content:space-between}.activity-kind{display:flex;align-items:center;gap:7px;color:#95b5d4;font-size:9px;font-weight:650;text-transform:uppercase;letter-spacing:.06em}.activity-kind i{display:block;width:7px;height:7px;background:var(--cloud);border-radius:50%}.deliberation .activity-kind{color:#bda3d1}.deliberation .activity-kind i{background:var(--violet)}.activity-status{padding:3px 7px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:var(--font-mono);font-size:8px;text-transform:capitalize}.activity-copy{margin-top:25px}.activity-copy h2{margin:0;color:var(--text);font-size:16px;font-weight:590}.activity-copy p{display:-webkit-box;min-height:45px;margin:7px 0 0;overflow:hidden;color:var(--secondary);font-size:10px;line-height:1.5;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3}.activity-meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:auto;padding:14px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.activity-meta span,.activity-meta strong{display:block}.activity-meta span{color:var(--muted);font-size:8px}.activity-meta strong{margin-top:4px;color:var(--text);font-size:9px;font-weight:560}.activity-card footer{display:flex;align-items:center;justify-content:space-between;padding-top:13px}.activity-card footer code{color:var(--muted);font-size:8px}.activity-card footer span{color:var(--secondary);font-size:9px}.activity-card footer b{margin-left:5px;color:var(--accent);font-weight:500}.activity-empty-mark{position:relative;width:54px;height:38px;margin-bottom:13px}.activity-empty-mark span{position:absolute;width:30px;height:25px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:6px}.activity-empty-mark span:nth-child(1){top:0;left:0}.activity-empty-mark span:nth-child(2){top:0;right:0}.activity-empty-mark span:nth-child(3){bottom:0;left:12px;background:var(--accent-soft);border-color:rgb(208 164 92 / 25%)}
	@media(max-width:1050px){.activity-grid{grid-template-columns:repeat(2,minmax(250px,1fr))}}@media(max-width:700px){.activity-summary{display:grid;grid-template-columns:1fr 1fr}.activity-summary>div{min-width:0}.activity-summary>div:first-child{grid-column:1/-1}.activity-grid{grid-template-columns:1fr}.activity-section-heading small{display:none}}@media(max-width:620px){.activity-summary{grid-template-columns:1fr}.activity-summary>div:first-child{grid-column:auto}}
</style>
