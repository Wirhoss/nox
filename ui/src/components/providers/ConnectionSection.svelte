<script lang="ts">
	/*
	 * Where the provider lives and how Nox talks to it.
	 *
	 * The id is fixed once created: it is the key blueprints and sessions
	 * reference, so renaming would orphan them. Editing an existing provider
	 * therefore disables that field rather than hiding it.
	 */
	import { setDraftField, draft, status } from "../../stores/providers";

	type Props = { view: "new" | "edit" };

	let { view }: Props = $props();
</script>

<section id="connection" class="form-section">
	<header><span>01</span><div><h2>Connection</h2><p>Identify the endpoint Nox uses for model requests.</p></div></header>

	<div class="field-grid two">
		<label>
			<span>Provider ID</span>
			<input
				value={$draft.id}
				oninput={(event) => setDraftField("id", event.currentTarget.value)}
				disabled={view === "edit" || $status.loading}
				placeholder="local-llama"
				autocomplete="off"
			/>
			<small>Stable ID used by blueprints and sessions.</small>
		</label>
		<label>
			<span>Protocol</span>
			<!-- No change handler: one protocol is supported, so the control is
			     here to show what the provider speaks, not to choose it. -->
			<select value={$draft.type} disabled={$status.loading}>
				<option value="openai_completions">OpenAI completions</option>
			</select>
			<small>Works with OpenAI-compatible endpoints.</small>
		</label>
	</div>

	<label class="wide-field">
		<span>Base URL</span>
		<input
			value={$draft.baseUrl}
			oninput={(event) => setDraftField("baseUrl", event.currentTarget.value)}
			disabled={$status.loading}
			placeholder="http://localhost:11434/v1"
			inputmode="url"
		/>
		<small>Include the API prefix expected before <code>/models</code> and <code>/chat/completions</code>.</small>
	</label>

	<div class="field-grid two provider-options">
		<label>
			<span>Default model <em>Optional</em></span>
			<input
				value={$draft.defaultModel ?? ""}
				oninput={(event) => setDraftField("defaultModel", event.currentTarget.value)}
				disabled={$status.loading}
				placeholder="model-id"
			/>
			<small>Used when a run does not select one explicitly.</small>
		</label>
		<label>
			<span>Request timeout <em>Optional</em></span>
			<div class="input-suffix">
				<input
					type="number"
					min="1"
					value={$draft.timeoutMs ?? ""}
					oninput={(event) => setDraftField(
						"timeoutMs",
						event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber,
					)}
					disabled={$status.loading}
					placeholder="30000"
				/>
				<b>ms</b>
			</div>
			<small>Leave empty to use the runtime default.</small>
		</label>
	</div>
</section>

<style>
	.wide-field {
		display: block;
		margin-top: 17px;
	}
	.provider-options { margin-top: 17px; }
</style>
