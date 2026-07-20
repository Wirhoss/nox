<script lang="ts">
	/*
	 * The provider's API key.
	 *
	 * The stored value is never returned by the gateway, so this field is
	 * always blank on open. Leaving it blank keeps whatever is stored; removing
	 * a credential is a separate, explicit action, which is why the clear
	 * toggle exists instead of treating an emptied field as a deletion.
	 */
	import { clearApiKey, newApiKey, setClearApiKey, setNewApiKey, status, storedApiKey } from "../../stores/providers";
</script>

<section id="credentials" class="form-section">
	<header><span>02</span><div><h2>Credentials</h2><p>Secrets are written to the local provider configuration.</p></div></header>

	<div class="credential-field">
		<label>
			<span>API key <em>Optional</em></span>
			<input
				type="password"
				value={$newApiKey}
				oninput={(event) => setNewApiKey(event.currentTarget.value)}
				disabled={$status.loading || $clearApiKey}
				autocomplete="new-password"
				placeholder={$storedApiKey ? "Stored key — enter to replace" : "Not required for many local endpoints"}
			/>
			<small>
				{$storedApiKey && !$clearApiKey
					? "A credential is currently stored. Its value is never returned to the browser."
					: "No credential will be sent unless you provide one."}
			</small>
		</label>
		{#if $storedApiKey}
			<button
				class:marked={$clearApiKey}
				class="credential-clear"
				type="button"
				onclick={() => { setClearApiKey(!$clearApiKey); setNewApiKey(""); }}
			>
				{$clearApiKey ? "Keep stored key" : "Remove stored key"}
			</button>
		{/if}
	</div>
</section>

<style>
	.credential-field {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: 10px;
	}
	/* margin-top clears the field label so the button lines up with the input. */
	.credential-clear {
		height: 37px;
		margin-top: 24px;
		padding: 0 10px;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		cursor: pointer;
		font-size: 9px;
	}
	.credential-clear:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.credential-clear.marked {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 20%);
		color: #dc8f89;
	}

	@media (max-width: 620px) {
		.credential-field { grid-template-columns: 1fr; }
		.credential-clear {
			width: max-content;
			margin-top: 0;
		}
	}
</style>
