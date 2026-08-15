<script lang="ts">
	/*
	 * Per-capability web tool configuration.
	 *
	 * Each capability picks one service, and every service declares its own
	 * fields, so the form below is rendered from that schema rather than from
	 * hard-coded inputs — `getNested` reads a field's dot path out of an
	 * otherwise opaque config object.
	 *
	 * The two field groups are kept apart on purpose: `serviceConfig` is how
	 * Nox reaches the service, `contract` is what an agent may pass to it.
	 */
	import FormError from "../shared/FormError.svelte";
	import FormSaved from "../shared/FormSaved.svelte";
	import { getNested } from "../../utils/schema-form";
	import {
		changeService,
		clearSecrets,
		filteredCapabilityKinds,
		initializeCapability,
		saveWebTools,
		secretValues,
		serviceLabelFor,
		setClearSecret,
		setSecretValue,
		status,
		updateWebField,
		webConfig,
		webForm,
		webServices,
	} from "../../stores/settings";

	import type { SettingsField } from "../../utils/types";

	/** Reads the value a schema-described input should submit. */
	const fieldValue = (field: SettingsField, target: HTMLInputElement): unknown =>
		field.type === "boolean"
			? target.checked
			: field.type === "number"
				? target.valueAsNumber
				: target.value;
</script>

<form class="settings-subsection web-tools-settings" onsubmit={(event) => { event.preventDefault(); saveWebTools(); }}>
	<div class="settings-subheading"><div><h3>Web tools</h3><p>Configure service-specific connections and the arguments exposed to agents.</p></div></div>
	<div class="web-tool-list">
		{#each $filteredCapabilityKinds as capabilityKind}
			<details class="web-tool-card">
				<summary><span class="web-tool-summary-mark">⌘</span><span class="web-tool-summary-copy"><strong>{capabilityKind.label}</strong><small>{capabilityKind.description}</small></span><span class="web-tool-summary-service">{serviceLabelFor(capabilityKind.id)}</span><span class="web-tool-chevron" aria-hidden="true">⌄</span></summary>
				<div class="web-tool-body">
				{#if $webConfig[capabilityKind.id]}
					<p class="web-tool-description">{capabilityKind.description}</p>
					<label class="wide-field"><span>Service</span><select value={$webConfig[capabilityKind.id]?.service} disabled={$webForm.saving} onchange={(event) => changeService(capabilityKind.id, event.currentTarget.value)}>{#each $webServices[capabilityKind.id] as service}<option value={service.id}>{service.label}</option>{/each}</select></label>
					{#each $webServices[capabilityKind.id].filter((service) => service.id === $webConfig[capabilityKind.id]?.service) as definition}
						<div class="web-config-group"><h4>Service connection</h4><div class="field-grid web-config-grid">
							{#each definition.serviceFields as field}
								<label><span>{field.label}{field.required ? " *" : ""}</span>
									{#if field.secret}
										<input type="password" value={$secretValues[capabilityKind.id]} disabled={$webForm.saving || $clearSecrets[capabilityKind.id]} placeholder={$webConfig[capabilityKind.id]?.hasApiKey ? "Stored — enter to replace" : "Optional"} oninput={(event) => setSecretValue(capabilityKind.id, event.currentTarget.value)} />
										{#if $webConfig[capabilityKind.id]?.hasApiKey}<small><span class="clear-secret"><input type="checkbox" checked={$clearSecrets[capabilityKind.id]} onchange={(event) => setClearSecret(capabilityKind.id, event.currentTarget.checked)} /> Remove stored key</span></small>{/if}
									{:else if field.type === "boolean"}
										<input type="checkbox" checked={Boolean(getNested($webConfig[capabilityKind.id]!.serviceConfig, field.name))} disabled={$webForm.saving} onchange={(event) => updateWebField(capabilityKind.id, "serviceConfig", field, fieldValue(field, event.currentTarget))} />
									{:else}
										<input type={field.type === "number" ? "number" : field.type} min={field.minimum} max={field.maximum} required={field.required} value={String(getNested($webConfig[capabilityKind.id]!.serviceConfig, field.name) ?? "")} disabled={$webForm.saving} oninput={(event) => updateWebField(capabilityKind.id, "serviceConfig", field, fieldValue(field, event.currentTarget))} />
									{/if}
									{#if field.help && !field.secret}<small>{field.help}</small>{/if}
								</label>
							{/each}
						</div></div>
						<div class="web-config-group"><h4>Agent contract</h4><div class="field-grid web-config-grid">
							{#each definition.contractFields as field}
								<label class:boolean-field={field.type === "boolean"}><span>{field.label}{field.required ? " *" : ""}</span>
									{#if field.type === "boolean"}
										<input type="checkbox" checked={Boolean(getNested($webConfig[capabilityKind.id]!.contract, field.name))} disabled={$webForm.saving} onchange={(event) => updateWebField(capabilityKind.id, "contract", field, fieldValue(field, event.currentTarget))} />
									{:else}
										<input type={field.type === "number" ? "number" : "text"} min={field.minimum} max={field.maximum} required={field.required} value={String(getNested($webConfig[capabilityKind.id]!.contract, field.name) ?? "")} disabled={$webForm.saving} oninput={(event) => updateWebField(capabilityKind.id, "contract", field, fieldValue(field, event.currentTarget))} />
									{/if}
									{#if field.help}<small>{field.help}</small>{/if}
								</label>
							{/each}
						</div></div>
					{/each}
				{:else}
					<div class="unconfigured-tool"><div><strong>No service configured</strong><p>Choose the first available service and complete its connection settings.</p></div><button class="button secondary" type="button" disabled={$webForm.saving || $webServices[capabilityKind.id].length === 0} onclick={() => initializeCapability(capabilityKind.id)}>Configure service</button></div>
				{/if}
				</div>
			</details>
		{:else}
			<div class="settings-empty"><span>⌕</span><div><strong>No matching configurable tools</strong><p>Try another name or service.</p></div></div>
		{/each}
	</div>
	{#if $webForm.error}<FormError message={$webForm.error} />{/if}
	{#if $webForm.saved}
		<FormSaved
			title="Web tools saved"
			detail="New sessions will use the updated service and contract configuration."
		/>
	{/if}
	<div class="settings-actions"><span>Changes apply to newly created or restored sessions.</span><button class="button primary" type="submit" disabled={$status.loading || $webForm.saving}>{$webForm.saving ? "Saving…" : "Save web tools"}</button></div>
</form>

<style>
	/* ---------------------------------------------------------- web tools */

	.web-tools-settings { padding-bottom: 0; }
	/* Reaches into FormError, which renders the .form-error element. */
	.web-tools-settings > :global(.form-error) { margin: 13px 0 0; }
	.web-tool-list {
		display: grid;
		gap: 12px;
	}
	.web-tool-card {
		overflow: hidden;
		background: var(--surface-sunken);
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.web-tool-card > summary {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr) auto 18px;
		min-height: 62px;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		cursor: pointer;
		list-style: none;
	}
	.web-tool-card > summary::-webkit-details-marker { display: none; }
	.web-tool-card > summary:hover { background: var(--surface-2); }
	.web-tool-card[open] > summary { border-bottom: 1px solid var(--border); }
	.web-tool-summary-mark {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 15%);
		border-radius: 7px;
		color: var(--healthy);
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.web-tool-summary-copy { min-width: 0; }
	.web-tool-summary-copy strong,
	.web-tool-summary-copy small { display: block; }
	.web-tool-summary-copy strong {
		font-size: 10px;
		font-weight: 590;
	}
	.web-tool-summary-copy small {
		margin-top: 3px;
		overflow: hidden;
		color: var(--muted);
		font-size: 8px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.web-tool-summary-service {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}
	.web-tool-chevron {
		color: var(--muted);
		font-size: 13px;
		transition: transform 140ms ease;
	}
	.web-tool-card[open] .web-tool-chevron { transform: rotate(180deg); }
	.web-tool-body { padding: 14px; }
	.web-tool-description {
		margin: 0 0 14px;
		color: var(--muted);
		font-size: 8px;
	}
	.unconfigured-tool {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px;
		background: var(--surface-2);
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
	}
	.unconfigured-tool strong {
		font-size: 9px;
		font-weight: 580;
	}
	.unconfigured-tool p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 8px;
	}
	.boolean-field input,
	.clear-secret input {
		width: 14px;
		height: 14px;
		accent-color: var(--accent);
	}
	.web-tool-body > .wide-field { display: block; }
	.web-tool-body > .wide-field select,
	.web-config-grid input {
		width: 100%;
		height: 35px;
		padding: 0 10px;
		background: var(--field-bg);
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		color: var(--text);
		outline: 0;
		font-size: 10px;
	}
	.web-tool-body > .wide-field select:focus,
	.web-config-grid input:focus {
		border-color: var(--field-border-focus);
		box-shadow: 0 0 0 2px rgb(208 164 92 / 7%);
	}
	.web-config-group {
		margin-top: 15px;
		padding-top: 13px;
		border-top: 1px solid var(--border);
	}
	.web-config-group h4 {
		margin: 0 0 10px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 550;
		letter-spacing: .045em;
		text-transform: uppercase;
	}
	.web-config-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.web-config-grid label > span:first-child,
	.web-tool-body > .wide-field > span {
		display: block;
		margin-bottom: 6px;
		color: var(--secondary);
		font-size: 9px;
		font-weight: 540;
	}
	.web-config-grid label small {
		display: block;
		margin-top: 5px;
		color: var(--muted);
		font-size: 8px;
		line-height: 1.45;
	}
	.web-config-grid .boolean-field > input {
		width: 16px;
		height: 16px;
	}
	.clear-secret {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
</style>
