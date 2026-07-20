<script lang="ts">
	/*
	 * Which tool sets the blueprint may use, split by how they load.
	 *
	 * Core tools sit in the model's context on every turn; lazy tools are found
	 * through the tool router only when the model looks for one. The split is a
	 * context-budget decision, so both buckets are edited side by side.
	 *
	 * A tool belongs to exactly one bucket, which `addTool` enforces by
	 * removing it from the other.
	 */
	import { tools } from "../../stores/catalog";
	import {
		addTool,
		assignedToolCount,
		draft,
		filteredUnassignedTools,
		removeTool,
		setToolPickerQuery,
		status,
		toggleToolPicker,
		toolPickerMode,
		toolPickerQuery,
		unassignedTools,
	} from "../../stores/blueprints";
</script>

<section id="tools" class="form-section">
	<header>
		<span>04</span>
		<div>
			<h2>Tools</h2>
			<p>
				Core tools load immediately; lazy tools are discovered when
				needed.
			</p>
		</div>
		<span class="section-count">{$assignedToolCount} assigned</span>
	</header>
	{#if $tools.length === 0 && $assignedToolCount === 0 && !$status.loading}<div class="tool-empty">
			No tool sets are currently registered. You can still save a
			model-only blueprint.
		</div>{:else}<div class="tool-assignment-grid">
			{#each [{ mode: "core" as const, title: "Core tools", description: "Available to the model on every turn.", items: $draft.coreTools }, { mode: "lazy" as const, title: "Lazy tools", description: "Discovered through the tool router when needed.", items: $draft.lazyLoadedTools }] as group}
				<section class="tool-bucket">
					<header><div><strong>{group.title}</strong><span>{group.description}</span></div><span class="tool-bucket-count">{group.items.length}</span><button class="tool-add-button" type="button" disabled={$status.loading} onclick={() => toggleToolPicker(group.mode)} aria-label={`Add ${group.title.toLowerCase()}`}>+</button></header>
					{#if $toolPickerMode === group.mode}<div class="tool-picker">
						<label><span aria-hidden="true">⌕</span><input type="search" value={$toolPickerQuery} oninput={(event) => setToolPickerQuery(event.currentTarget.value)} placeholder="Search available tool sets" aria-label={`Search tools to add as ${group.mode}`} /></label>
						<div class="tool-picker-results">
							{#each $filteredUnassignedTools as tool}<button type="button" onclick={() => addTool(tool, group.mode)}><span class="tool-icon">⌘</span><strong>{tool}</strong><span aria-hidden="true">+</span></button>{:else}<p>{$unassignedTools.length === 0 ? "All available tool sets are assigned." : "No matching tool sets."}</p>{/each}
						</div>
					</div>{/if}
					<div class="assigned-tool-list">
						{#each group.items as tool}<div class="assigned-tool">
							<span class="tool-icon">⌘</span><div><strong>{tool}</strong><span>{$tools.includes(tool) ? (group.mode === "core" ? "Loaded immediately" : "Loaded on demand") : "Currently unavailable"}</span></div><button type="button" onclick={() => removeTool(tool, group.mode)} disabled={$status.loading} aria-label={`Remove ${tool} from ${group.title.toLowerCase()}`}>×</button>
						</div>{:else}<div class="tool-bucket-empty">No {group.mode} tools assigned.</div>{/each}
					</div>
				</section>
			{/each}
		</div>{/if}
</section>

<style>
	/* ---------------------------------------------------------- tool picker */

	.tool-assignment-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		align-items: start;
		gap: 12px;
	}
	.tool-bucket {
		position: relative;
		min-width: 0;
		background: var(--surface-sunken);
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.tool-bucket > header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 28px;
		align-items: center;
		gap: 9px;
		min-height: 57px;
		padding: 9px 10px;
		border-bottom: 1px solid var(--border);
	}
	.tool-bucket > header strong,
	.tool-bucket > header span { display: block; }
	.tool-bucket > header strong {
		font-size: 10px;
		font-weight: 590;
	}
	.tool-bucket > header div > span {
		margin-top: 3px;
		color: var(--muted);
		font-size: 8px;
	}
	.tool-bucket-count {
		min-width: 21px;
		padding: 3px 6px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
		text-align: center;
	}
	.tool-add-button {
		width: 28px;
		height: 28px;
		padding: 0;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 20%);
		border-radius: 6px;
		color: var(--accent);
		cursor: pointer;
		font-size: 16px;
	}
	.tool-add-button:hover:not(:disabled) { background: rgb(208 164 92 / 16%); }
	.tool-add-button:disabled { cursor: not-allowed; opacity: .4; }
	.assigned-tool-list { min-height: 72px; }
	.assigned-tool {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) 25px;
		align-items: center;
		gap: 9px;
		min-height: 56px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
	}
	.assigned-tool:last-child { border-bottom: 0; }
	.assigned-tool > div { min-width: 0; }
	.assigned-tool strong,
	.assigned-tool div span { display: block; }
	.assigned-tool strong {
		overflow: hidden;
		font-size: 10px;
		font-weight: 570;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.assigned-tool div span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	.assigned-tool > button {
		width: 25px;
		height: 25px;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		color: var(--muted);
		cursor: pointer;
		font-size: 14px;
	}
	.assigned-tool > button:hover {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 15%);
		color: var(--danger);
	}
	.tool-bucket-empty {
		display: grid;
		min-height: 72px;
		place-items: center;
		padding: 14px;
		color: var(--muted);
		font-size: 8px;
		text-align: center;
	}
	.tool-picker {
		position: absolute;
		z-index: 5;
		top: 61px;
		right: 8px;
		left: 8px;
		padding: 8px;
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		box-shadow: 0 14px 35px rgb(0 0 0 / 28%);
	}
	.tool-picker > label { position: relative; }
	.tool-picker > label > span {
		position: absolute;
		top: 50%;
		left: 9px;
		color: var(--muted);
		transform: translateY(-50%);
	}
	.tool-picker input {
		width: 100%;
		height: 32px;
		padding: 0 9px 0 28px;
		background: var(--field-bg);
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		color: var(--text);
		font-size: 9px;
		outline: 0;
	}
	.tool-picker input:focus { border-color: var(--field-border-focus); }
	.tool-picker-results {
		display: grid;
		max-height: 190px;
		margin-top: 7px;
		overflow-y: auto;
	}
	.tool-picker-results button {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) 15px;
		align-items: center;
		gap: 8px;
		padding: 7px;
		background: transparent;
		border: 0;
		border-radius: 5px;
		color: var(--text);
		cursor: pointer;
		text-align: left;
	}
	.tool-picker-results button:hover { background: var(--surface-hover); }
	.tool-picker-results button strong {
		overflow: hidden;
		font-size: 9px;
		font-weight: 560;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool-picker-results button > span:last-child {
		color: var(--accent);
		font-size: 13px;
	}
	.tool-picker-results p {
		margin: 0;
		padding: 14px 8px;
		color: var(--muted);
		font-size: 8px;
		text-align: center;
	}
	.tool-icon {
		display: grid;
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 15%);
		border-radius: 6px;
		color: var(--healthy);
		font-size: 10px;
	}
	.tool-empty {
		padding: 16px;
		background: var(--surface-sunken);
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
		color: var(--muted);
		font-size: 10px;
		text-align: center;
	}

	@media (max-width: 620px) {
		.tool-assignment-grid { grid-template-columns: 1fr; }
	}
</style>
