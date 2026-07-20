<script lang="ts">
	/*
	 * Where the blueprint runs.
	 *
	 * Model ids are not unique across providers, so changing the provider goes
	 * through `selectProvider`, which drops a model the new provider does not
	 * offer instead of carrying over an id that would name nothing.
	 */
	import { prettyType } from "../../utils/validation";
	import { providers, unavailableModelProviders } from "../../stores/catalog";
	import {
		availableModels,
		draft,
		selectableModels,
		selectProvider,
		selectedProvider,
		setConfigField,
		status,
	} from "../../stores/blueprints";
</script>

<section id="runtime" class="form-section">
	<header>
		<span>03</span>
		<div>
			<h2>Provider & model</h2>
			<p>Choose where this blueprint runs.</p>
		</div>
	</header>
	{#if $providers.length === 0 && !$status.loading}<div class="form-callout">
			<strong>No providers configured</strong><span
				>A provider is required before this blueprint can be saved.</span
			>
		</div>{/if}
	<div class="field-grid two">
		<label
			><span>Provider</span><select
				value={$draft.config.providerId}
				onchange={(event) => selectProvider(event.currentTarget.value)}
				disabled={$status.loading}
				><option value="">Select provider…</option
				>{#each $providers as provider}<option value={provider.id}
						>{provider.id} · {prettyType(
							provider.type,
						)}{provider.status === "inactive"
							? " (inactive)"
							: ""}</option
					>{/each}</select
			><small class:warning={$selectedProvider?.status === "inactive"}
				>{$selectedProvider?.status === "inactive"
					? "This provider is configured but inactive."
					: $selectedProvider
						? `${prettyType($selectedProvider.type)} · ${$selectedProvider.status}`
						: "Local and cloud execution stay explicit."}</small
			></label
		><label
			><span>Model</span><select
				value={$draft.config.modelId} onchange={(event) => setConfigField("modelId", event.currentTarget.value)}
				disabled={$status.loading || !$draft.config.providerId}
				><option value="">Select model…</option
				>{#each $selectableModels as model}<option
						value={model.modelId}>{model.modelId}</option
					>{/each}</select
			><small
				class:warning={$unavailableModelProviders.has(
					$draft.config.providerId,
				)}
				>{$unavailableModelProviders.has($draft.config.providerId)
					? "Live inventory unavailable; showing configured models only."
					: $draft.config.providerId && $availableModels.length === 0
						? "The provider reported no available models."
						: $draft.config.providerId
							? `${$availableModels.length} models available from the provider.`
							: "Select a provider to load its models."}</small
			></label
		>
	</div>
</section>
