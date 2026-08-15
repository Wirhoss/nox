<script lang="ts">
	import type { Blueprint } from "../../utils/types";
	import Avatar from "../shared/Avatar.svelte";

	type Props = {
		blueprints: readonly Blueprint[];
		max?: number;
		onchange: (selected: string[]) => void;
		selected: readonly string[];
	};

	let { blueprints, max = 8, onchange, selected }: Props = $props();
	let open = $state(false);
	let search = $state("");

	const selectedBlueprints = $derived(selected.map((id) => blueprints.find((blueprint) => blueprint.id === id) ?? {
		config: { maxIterations: 0, modelId: "", providerId: "" },
		coreTools: [],
		description: "Blueprint unavailable",
		id,
		lazyLoadedTools: [],
		systemPrompt: "",
	}));
	const filtered = $derived(blueprints.filter((blueprint) => {
		const needle = search.trim().toLowerCase();
		return !needle || `${blueprint.id} ${blueprint.description}`.toLowerCase().includes(needle);
	}));

	const toggle = (id: string): void => {
		if (selected.includes(id)) {
			onchange(selected.filter((candidate) => candidate !== id));
			return;
		}
		if (selected.length < max) onchange([...selected, id]);
	};

	const show = (): void => {
		search = "";
		open = true;
	};
</script>

<svelte:window onkeydown={(event) => { if (open && event.key === "Escape") open = false; }} />

<div class="participant-picker">
	{#if selectedBlueprints.length > 0}
		<div class="selected-list">
			{#each selectedBlueprints as blueprint, index}
				<div class="selected-participant">
					<span class="order">{index + 1}</span>
					<Avatar decorative seed={blueprint.id} size={28} />
					<span class="identity"><strong>{blueprint.id}</strong><small>{blueprint.description}</small></span>
					<button type="button" aria-label={`Remove ${blueprint.id}`} onclick={() => toggle(blueprint.id)}>×</button>
				</div>
			{/each}
		</div>
	{:else}
		<div class="selection-empty"><strong>No participants selected</strong><span>Add at least two blueprints with distinct perspectives.</span></div>
	{/if}

	<button class="add-participant" type="button" disabled={selected.length >= max} onclick={show}><span>+</span>{selected.length >= max ? `Maximum of ${max} participants` : "Add participants"}</button>
	<small class="selection-count">{selected.length} of {max} selected</small>
</div>

{#if open}
	<div class="picker-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) open = false; }}>
		<div class="picker-dialog" role="dialog" aria-modal="true" aria-labelledby="participant-picker-title">
			<header><div><span class="panel-kicker">Blueprint library</span><h2 id="participant-picker-title">Add participants</h2></div><button type="button" aria-label="Close participant picker" onclick={() => open = false}>×</button></header>
			<div class="picker-search"><span aria-hidden="true">⌕</span><input bind:value={search} placeholder="Search blueprints…" aria-label="Search blueprints" /><kbd>{filtered.length}</kbd></div>
			<div class="picker-results">
				{#if filtered.length === 0}<div class="no-results"><strong>No matching blueprints</strong><span>Try another name or description.</span></div>{/if}
				{#each filtered as blueprint}
					<button class:selected={selected.includes(blueprint.id)} disabled={!selected.includes(blueprint.id) && selected.length >= max} type="button" onclick={() => toggle(blueprint.id)}>
						<Avatar decorative seed={blueprint.id} size={28} />
						<span class="identity"><strong>{blueprint.id}</strong><small>{blueprint.description || "No description"}</small></span>
						<b>{selected.includes(blueprint.id) ? "✓ Added" : "+ Add"}</b>
					</button>
				{/each}
			</div>
			<footer><span>Select two or more independent perspectives.</span><button class="button primary" type="button" onclick={() => open = false}>Done · {selected.length}</button></footer>
		</div>
	</div>
{/if}

<style>
	.participant-picker{display:grid;gap:8px}.selected-list{display:grid;gap:6px}.selected-participant{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 10px;background:var(--surface-sunken);border:1px solid var(--border);border-radius:6px}.order{display:grid;width:18px;height:18px;place-items:center;color:var(--muted);font:7px var(--font-mono)}.identity{min-width:0}.identity strong,.identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.identity strong{color:var(--text);font-size:9px}.identity small{margin-top:3px;color:var(--muted);font-size:8px}.selected-participant>button{display:grid;width:25px;height:25px;place-items:center;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--muted);font-size:14px;cursor:pointer}.selected-participant>button:hover{background:var(--danger-soft);border-color:rgb(216 120 114 / 18%);color:var(--danger-text)}.selection-empty{padding:22px;background:var(--surface-sunken);border:1px dashed var(--border-strong);border-radius:7px;text-align:center}.selection-empty strong,.selection-empty span{display:block}.selection-empty strong{font-size:10px}.selection-empty span{margin-top:4px;color:var(--muted);font-size:8px}.add-participant{display:flex;height:36px;align-items:center;justify-content:center;gap:7px;background:rgb(170 139 194 / 7%);border:1px solid rgb(170 139 194 / 25%);border-radius:6px;color:#c6add8;font-size:9px;font-weight:600;cursor:pointer}.add-participant span{font-size:15px;font-weight:400}.add-participant:disabled{cursor:not-allowed;opacity:.5}.selection-count{color:var(--muted);font:7px var(--font-mono);text-align:right}.picker-backdrop{position:fixed;z-index:80;inset:0;display:grid;padding:24px;background:rgb(4 6 5 / 72%);backdrop-filter:blur(4px);place-items:center}.picker-dialog{display:grid;width:min(590px,100%);max-height:min(690px,90vh);overflow:hidden;background:var(--surface-1);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 24px 80px rgb(0 0 0 / 45%)}.picker-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:17px 18px;border-bottom:1px solid var(--border)}.picker-dialog h2{margin:3px 0 0;font-size:15px}.picker-dialog>header>button{display:grid;width:28px;height:28px;place-items:center;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:15px;cursor:pointer}.picker-search{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;margin:13px 14px 7px;padding:0 10px;background:var(--surface-sunken);border:1px solid var(--border);border-radius:6px}.picker-search>span{color:var(--muted);font-size:13px}.picker-search input{height:37px;padding:0;background:transparent;border:0;outline:0}.picker-search kbd{color:var(--muted);font:7px var(--font-mono)}.picker-results{display:grid;gap:5px;min-height:180px;padding:7px 14px 14px;overflow:auto}.picker-results>button{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px;background:var(--surface-sunken);border:1px solid var(--border);border-radius:6px;text-align:left;cursor:pointer}.picker-results>button:hover,.picker-results>button.selected{border-color:rgb(170 139 194 / 35%)}.picker-results>button.selected{background:rgb(170 139 194 / 7%)}.picker-results>button>b{color:var(--muted);font-size:8px}.picker-results>button.selected>b{color:#c6add8}.picker-results>button:disabled{cursor:not-allowed;opacity:.4}.no-results{padding:45px;text-align:center}.no-results strong,.no-results span{display:block}.no-results strong{font-size:10px}.no-results span{margin-top:4px;color:var(--muted);font-size:8px}.picker-dialog>footer{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-top:1px solid var(--border)}.picker-dialog>footer>span{color:var(--muted);font-size:8px}@media(max-width:620px){.picker-backdrop{padding:10px}.picker-dialog{max-height:94vh}.picker-dialog>footer>span{display:none}.picker-dialog>footer{justify-content:flex-end}}
</style>
