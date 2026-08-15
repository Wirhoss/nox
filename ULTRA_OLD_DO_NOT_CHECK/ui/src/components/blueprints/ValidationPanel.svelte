<script lang="ts">
	/*
	 * Running readiness checklist beside the blueprint form.
	 *
	 * Shows progress rather than errors: the form is incomplete for most of the
	 * time it is open. Real validation messages surface only on submit, via
	 * `FormError`.
	 */
	import FormError from "../shared/FormError.svelte";
	import { isValidResourceId } from "../../utils/validation";
	import {
		assignedToolCount,
		draft,
		selectableModels,
		selectedProvider,
		status,
	} from "../../stores/blueprints";
</script>

<aside class="validation-panel">
	<div class="validation-sticky">
		<span class="panel-kicker">Validation</span>
		<h2>Ready check</h2>
		<div class="validation-list">
			<div
				class:valid={Boolean(
					$draft.id && /^[a-zA-Z0-9_-]+$/.test($draft.id),
				)}
			>
				<span
					>{$draft.id && /^[a-zA-Z0-9_-]+$/.test($draft.id)
						? "✓"
						: "·"}</span
				>
				<div>
					<strong>Identity</strong><small>Valid blueprint ID</small>
				</div>
			</div>
			<div class:valid={Boolean($selectedProvider)}>
				<span>{$selectedProvider ? "✓" : "·"}</span>
				<div>
					<strong>Provider</strong><small
						>{$selectedProvider?.id ?? "Not selected"}</small
					>
				</div>
			</div>
			<div
				class:valid={Boolean(
					$draft.config.modelId &&
						$selectableModels.some(
							(model) => model.modelId === $draft.config.modelId,
						),
				)}
			>
				<span
					>{$draft.config.modelId &&
					$selectableModels.some(
						(model) => model.modelId === $draft.config.modelId,
					)
						? "✓"
						: "·"}</span
				>
				<div>
					<strong>Model</strong><small
						>{$draft.config.modelId || "Not selected"}</small
					>
				</div>
			</div>
			<div class="valid">
				<span>✓</span>
				<div>
					<strong>Tools</strong><small
						>{assignedToolCount
							? `${$draft.coreTools.length} core, ${$draft.lazyLoadedTools.length} lazy`
							: "Model only"}</small
					>
				</div>
			</div>
		</div>
		{#if $status.formError}<FormError message={$status.formError} />{/if}
		<div class="validation-note">
			<strong>Configuration is persisted locally</strong>
			<p>Existing sessions keep the instructions they started with.</p>
		</div>
	</div>
</aside>
