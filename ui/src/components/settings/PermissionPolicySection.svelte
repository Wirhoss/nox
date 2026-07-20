<script lang="ts">
	/*
	 * The global tool-permission policy.
	 *
	 * Rules are evaluated after each tool set's own defaults and before a call
	 * runs, so this is the last chance to deny or ask. Each policy is edited as
	 * free text and parsed on save — see `utils/gate-rules.ts` for why the
	 * conditions are validated here rather than inside the gate.
	 */
	import FormError from "../shared/FormError.svelte";
	import FormSaved from "../shared/FormSaved.svelte";
	import {
		addRule,
		gateForm,
		removeRule,
		rules,
		saveGate,
		setTimeoutSeconds,
		status,
		timeoutSeconds,
		updateRule,
	} from "../../stores/settings";
</script>

<form id="permissions" class="settings-subsection permission-settings" onsubmit={(event) => { event.preventDefault(); saveGate(); }}>
<div class="settings-subheading"><div><h3>Global permission policies</h3><p>Policies apply after the tool-specific defaults and before a call runs.</p></div><button class="button secondary" type="button" onclick={addRule} disabled={$status.loading || $gateForm.saving}><span aria-hidden="true">+</span> Add policy</button></div>
<label class="timeout-field"><span>Approval timeout</span><div class="input-suffix"><input type="number" min="1" step="1" value={$timeoutSeconds} oninput={(event) => setTimeoutSeconds(event.currentTarget.valueAsNumber)} disabled={$status.loading || $gateForm.saving} /><b>seconds</b></div><small>Pending requests are denied when this time expires.</small></label>

<div class="policy-list">
	{#each $rules as rule, index}
		<fieldset class="policy-card">
			<legend>Policy {String(index + 1).padStart(2, "0")}</legend>
			<button class="policy-remove" type="button" onclick={() => removeRule(index)} disabled={$gateForm.saving} aria-label={`Remove policy ${index + 1}`}>×</button>
			<div class="field-grid policy-grid">
				<label><span>Tool calls</span><input value={rule.tools} oninput={(event) => updateRule(index, 'tools', event.currentTarget.value)} disabled={$gateForm.saving} placeholder="* or shell, search" /><small>Use <code>*</code> for every tool, or comma-separated call names.</small></label>
				<label><span>Action</span><select value={rule.verdict} onchange={(event) => updateRule(index, 'verdict', event.currentTarget.value as 'deny' | 'escalate')} disabled={$gateForm.saving}><option value="escalate">Ask for approval</option><option value="deny">Always deny</option></select><small>Deny rules take precedence over approval rules.</small></label>
			</div>
			<label class="wide-field"><span>Reason shown to the user</span><input value={rule.reason} oninput={(event) => updateRule(index, 'reason', event.currentTarget.value)} disabled={$gateForm.saving} placeholder="Explain why this call is protected" /></label>
			<label class="wide-field"><span>Argument conditions <em>Optional JSON</em></span><input value={rule.match} oninput={(event) => updateRule(index, 'match', event.currentTarget.value)} disabled={$gateForm.saving} placeholder={'{"path":"^/protected/"}'} /><small>Map argument names to regular expressions. All conditions must match.</small></label>
		</fieldset>
	{:else}
		<div class="settings-empty policy-empty"><span>✓</span><div><strong>No global policies</strong><p>Calls follow the defaults declared by each installed tool set.</p></div></div>
	{/each}
</div>
{#if $gateForm.error}<FormError message={$gateForm.error} />{/if}
{#if $gateForm.saved}
	<FormSaved
		title="Tool settings saved"
		detail="Restart Nox before starting new sessions to apply the updated policies."
	/>
{/if}
<div class="settings-actions"><span>Changes affect new sessions after restart.</span><button class="button primary" type="submit" disabled={$status.loading || $gateForm.saving}>{$gateForm.saving ? "Saving…" : "Save tool settings"}</button></div>
					</form>

<style>
	/* --------------------------------------------------- permission policy */

	.permission-settings { padding-bottom: 0; }
	/* Reaches into FormError, which renders the .form-error element. */
	.permission-settings > :global(.form-error) { margin: 13px 0 0; }

	/* These controls are a size down from the shared .form-section controls,
	   so geometry is restated here while colour stays on the tokens. */
	.timeout-field {
		display: block;
		width: min(280px, 100%);
		margin-bottom: 15px;
	}
	.timeout-field > span,
	.policy-card label > span {
		display: block;
		margin-bottom: 6px;
		color: var(--secondary);
		font-size: 9px;
		font-weight: 540;
	}
	.timeout-field input,
	.policy-card input,
	.policy-card select {
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
	.timeout-field input:focus,
	.policy-card input:focus,
	.policy-card select:focus {
		border-color: var(--field-border-focus);
		box-shadow: 0 0 0 2px rgb(208 164 92 / 7%);
	}
	.timeout-field small,
	.policy-card label small {
		display: block;
		margin-top: 5px;
		color: var(--muted);
		font-size: 8px;
		line-height: 1.45;
	}
	.timeout-field .input-suffix { width: 180px; }
	.timeout-field .input-suffix input { padding-right: 62px; }

	.policy-list {
		display: grid;
		gap: 10px;
	}
	.policy-card {
		position: relative;
		min-width: 0;
		margin: 0;
		padding: 17px 14px 14px;
		background: var(--surface-sunken);
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.policy-card legend {
		padding: 0 5px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: .055em;
		text-transform: uppercase;
	}
	.policy-card em {
		color: var(--muted);
		font-size: 7px;
		font-style: normal;
		font-weight: 500;
		text-transform: uppercase;
	}
	/* Paired with .field-grid, which supplies display: grid. */
	.policy-grid {
		grid-template-columns: minmax(0, 1.5fr) minmax(150px, .8fr);
		gap: 12px;
		margin-bottom: 12px;
	}
	/* Settings' .wide-field is a bare label; only sibling spacing applies. */
	.policy-card .wide-field + .wide-field { margin-top: 12px; }
	.policy-remove {
		position: absolute;
		top: 8px;
		right: 9px;
		width: 25px;
		height: 25px;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		color: var(--muted);
		cursor: pointer;
	}
	.policy-remove:hover {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 15%);
		color: var(--danger);
	}
	.policy-empty { min-height: 90px; }

	@media (max-width: 620px) {
		.policy-grid { grid-template-columns: 1fr; }
	}
</style>
