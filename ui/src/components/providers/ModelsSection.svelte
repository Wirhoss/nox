<script lang="ts">
	/*
	 * Optional per-model overrides.
	 *
	 * An active provider discovers its own models at startup, so this table is
	 * empty in the common case. It exists to declare a context window the
	 * provider does not report, which the runtime cannot infer.
	 */
	import { addModel, configuredModelCount, draft, removeModel, status, updateModel } from "../../stores/providers";
</script>

<section id="models" class="form-section">
	<header>
		<span>03</span>
		<div><h2>Model overrides</h2><p>Optionally define context limits for known models.</p></div>
		<span class="section-count">{$configuredModelCount} configured</span>
	</header>

	<div class="model-editor">
		<div class="model-editor-head"><span>Model ID</span><span>Context window</span><span></span></div>
		{#each $draft.modelConfigs as model, index}
			<div class="model-editor-row">
				<div>
					<input
						value={model.modelId}
						oninput={(event) => updateModel(index, "modelId", event.currentTarget.value)}
						disabled={$status.loading}
						placeholder="model-id"
						aria-label={`Model ${index + 1} ID`}
					/>
					<span class="model-kind">TEXT</span>
				</div>
				<div class="input-suffix">
					<input
						type="number"
						min="1"
						step="1"
						value={model.contextWindow ?? ""}
						oninput={(event) => updateModel(
							index,
							"contextWindow",
							event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber,
						)}
						disabled={$status.loading}
						placeholder="Auto"
						aria-label={`Context window for model ${index + 1}`}
					/>
					<b>tokens</b>
				</div>
				<button
					type="button"
					onclick={() => removeModel(index)}
					disabled={$status.loading}
					aria-label={`Remove model ${model.modelId || index + 1}`}
				>×</button>
			</div>
		{:else}
			<div class="model-editor-empty">
				<strong>No model overrides</strong>
				<span>Active providers discover available model IDs when Nox starts.</span>
			</div>
		{/each}
	</div>

	<button class="button secondary add-model" type="button" onclick={addModel} disabled={$status.loading}>
		<span aria-hidden="true">+</span> Add model override
	</button>
</section>

<style>
	.model-editor {
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.model-editor-head,
	.model-editor-row {
		display: grid;
		grid-template-columns: minmax(180px, 1fr) 170px 28px;
		align-items: center;
		gap: 9px;
	}
	.model-editor-head {
		min-height: 31px;
		padding: 0 10px;
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.model-editor-row {
		min-height: 56px;
		padding: 9px 10px;
		border-bottom: 1px solid var(--border);
	}
	.model-editor-row:last-child { border-bottom: 0; }
	/* Positioning context for the .model-kind tag pinned inside the input. */
	.model-editor-row > div:first-child { position: relative; }
	.model-editor-row input { height: 34px; }
	.model-editor-row > div:first-child input { padding-right: 48px; }
	.model-kind {
		position: absolute;
		top: 50%;
		right: 8px;
		padding: 2px 4px;
		background: var(--cloud-soft);
		border: 1px solid rgb(118 162 206 / 12%);
		border-radius: 3px;
		color: #82aacf;
		font-family: var(--font-mono);
		font-size: 7px;
		transform: translateY(-50%);
	}
	.model-editor-row > button {
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		color: var(--muted);
		cursor: pointer;
		font-size: 15px;
	}
	.model-editor-row > button:hover {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 16%);
		color: var(--danger);
	}
	.model-editor-empty {
		display: flex;
		min-height: 92px;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		background: #101411;
	}
	.model-editor-empty strong,
	.model-editor-empty span { display: block; }
	.model-editor-empty strong {
		font-size: 10px;
		font-weight: 560;
	}
	.model-editor-empty span {
		margin-top: 3px;
		color: var(--muted);
		font-size: 8px;
	}
	.add-model { margin-top: 10px; }

	@media (max-width: 620px) {
		.model-editor-head { display: none; }
		.model-editor-row {
			grid-template-columns: 1fr 28px;
			padding: 10px;
		}
		.model-editor-row :global(.input-suffix) { grid-column: 1; }
		.model-editor-row > button {
			grid-row: 1 / 3;
			grid-column: 2;
		}
	}
</style>
