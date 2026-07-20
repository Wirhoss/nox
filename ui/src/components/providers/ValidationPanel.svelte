<script lang="ts">
	/*
	 * Running checklist beside the provider form.
	 *
	 * Mirrors `validateDraft` in the store, but as progress rather than as
	 * errors: the form is incomplete for most of the time it is open, and
	 * showing failures for fields not yet reached would be noise. Real
	 * validation messages surface only on submit, through `FormError`.
	 */
	import FormError from "../shared/FormError.svelte";
	import { hostLabel } from "../../utils/validation";
	import {
		configuredModelCount,
		credentialsReady,
		draft,
		endpointValid,
		identityValid,
		status,
	} from "../../stores/providers";
</script>

<aside class="validation-panel">
	<div class="validation-sticky">
		<span class="panel-kicker">Connection check</span>
		<h2>Configuration</h2>

		<div class="validation-list">
			<div class:valid={$identityValid}>
				<span>{$identityValid ? "✓" : "·"}</span>
				<div><strong>Identity</strong><small>{$identityValid ? $draft.id : "Valid provider ID"}</small></div>
			</div>
			<div class:valid={$endpointValid}>
				<span>{$endpointValid ? "✓" : "·"}</span>
				<div><strong>Endpoint</strong><small>{$endpointValid ? hostLabel($draft.baseUrl) : "Absolute URL required"}</small></div>
			</div>
			<div class:valid={$credentialsReady}>
				<span>{$credentialsReady ? "✓" : "·"}</span>
				<div><strong>Credential</strong><small>{$credentialsReady ? "Will be stored" : "Optional"}</small></div>
			</div>
			<!-- Always satisfied: with no overrides the provider discovers its own. -->
			<div class="valid">
				<span>✓</span>
				<div><strong>Models</strong><small>{$configuredModelCount ? `${$configuredModelCount} overrides` : "Discover on restart"}</small></div>
			</div>
		</div>

		{#if $status.formError}<FormError message={$status.formError} />{/if}

		<div class="validation-note restart-note">
			<strong>Restart required after saving</strong>
			<p>Provider instances and model discovery are initialized when Nox starts.</p>
		</div>
	</div>
</aside>

<style>
	/* Amber variant of the shared validation note, for restart-required copy. */
	.restart-note {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 14%);
	}
	.restart-note strong { color: #d6b679; }
</style>
