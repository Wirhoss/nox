<script lang="ts">
	import { onMount } from "svelte";

	type GateRule = {
		tools: "*" | string[];
		match?: Record<string, string>;
		verdict: "deny" | "escalate";
		reason: string;
	};
	type GateConfig = { rules: GateRule[]; escalationTimeoutMs: number };
	type EditableRule = {
		tools: string;
		match: string;
		verdict: "deny" | "escalate";
		reason: string;
	};
	type ConfigMutation = { gate: GateConfig; restartRequired: boolean };
	type ApiError = { error?: { message?: string }; message?: string };

	let toolSets: string[] = [];
	let rules: EditableRule[] = [];
	let timeoutSeconds = 120;
	let loading = true;
	let saving = false;
	let errorMessage = "";
	let formError = "";
	let saved = false;

	async function request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(path, {
			...init,
			headers: {
				accept: "application/json",
				...(init?.body ? { "content-type": "application/json" } : {}),
				...init?.headers,
			},
		});
		if (!response.ok) {
			let body: ApiError = {};
			try {
				body = (await response.json()) as ApiError;
			} catch {
				/* use status fallback */
			}
			throw new Error(body.error?.message ?? body.message ?? `${response.status} ${response.statusText}`);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	const toEditableRule = (rule: GateRule): EditableRule => ({
		tools: rule.tools === "*" ? "*" : rule.tools.join(", "),
		match: rule.match ? JSON.stringify(rule.match) : "",
		verdict: rule.verdict,
		reason: rule.reason,
	});

	const load = async () => {
		loading = true;
		errorMessage = "";
		try {
			const [tools, gate] = await Promise.all([
				request<string[]>("/api/v1/tools"),
				request<GateConfig>("/api/v1/config/gate"),
			]);
			toolSets = tools;
			rules = gate.rules.map(toEditableRule);
			timeoutSeconds = gate.escalationTimeoutMs / 1000;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "Settings could not be loaded.";
		} finally {
			loading = false;
		}
	};

	const addRule = () => {
		rules = [...rules, { tools: "*", match: "", verdict: "escalate", reason: "Approval is required." }];
		saved = false;
	};

	const removeRule = (index: number) => {
		rules = rules.filter((_, ruleIndex) => ruleIndex !== index);
		saved = false;
	};

	const parseRule = (rule: EditableRule, index: number): GateRule => {
		const targets = rule.tools.trim() === "*"
			? "*" as const
			: rule.tools.split(",").map((tool) => tool.trim()).filter(Boolean);
		if (targets !== "*" && targets.length === 0) throw new Error(`Policy ${index + 1} needs at least one tool name.`);
		if (!rule.reason.trim()) throw new Error(`Policy ${index + 1} needs a reason.`);

		let match: Record<string, string> | undefined;
		if (rule.match.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rule.match);
			} catch {
				throw new Error(`Policy ${index + 1} has invalid condition JSON.`);
			}
			if (!parsed || Array.isArray(parsed) || typeof parsed !== "object"
				|| Object.values(parsed).some((value) => typeof value !== "string")) {
				throw new Error(`Policy ${index + 1} conditions must be a JSON object of regular-expression strings.`);
			}
			match = parsed as Record<string, string>;
			try {
				Object.values(match).forEach((source) => new RegExp(source));
			} catch {
				throw new Error(`Policy ${index + 1} contains an invalid regular expression.`);
			}
		}

		return {
			tools: targets,
			...(match ? { match } : {}),
			verdict: rule.verdict,
			reason: rule.reason.trim(),
		};
	};

	const save = async () => {
		formError = "";
		saved = false;
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
			formError = "Approval timeout must be greater than zero.";
			return;
		}
		let config: GateConfig;
		try {
			config = {
				rules: rules.map(parseRule),
				escalationTimeoutMs: Math.round(timeoutSeconds * 1000),
			};
		} catch (error) {
			formError = error instanceof Error ? error.message : "The policy configuration is invalid.";
			return;
		}

		saving = true;
		try {
			const result = await request<ConfigMutation>("/api/v1/config/gate", {
				method: "PUT",
				body: JSON.stringify(config),
			});
			rules = result.gate.rules.map(toEditableRule);
			timeoutSeconds = result.gate.escalationTimeoutMs / 1000;
			saved = true;
		} catch (error) {
			formError = error instanceof Error ? error.message : "Tool policies could not be saved.";
		} finally {
			saving = false;
		}
	};

	onMount(load);
</script>

<section class="settings-page">
	<header class="page-heading settings-heading">
		<div>
			<div class="eyebrow">Application</div>
			<h1>Settings</h1>
			<p>Configure installed capabilities. Brokers and tools are supplied by Nox or app extensions.</p>
		</div>
	</header>

	{#if errorMessage}
		<div class="error-state settings-error">
			<div class="error-symbol">!</div><strong>Settings unavailable</strong><p>{errorMessage}</p>
			<button class="button secondary" type="button" onclick={load}>Try again</button>
		</div>
	{:else}
		<div class="settings-layout">
			<nav class="settings-nav" aria-label="Settings sections">
				<span>Application settings</span>
				<a href="#brokers"><span class="settings-nav-icon">⇄</span><div><strong>Brokers</strong><small>Connections and routing</small></div></a>
				<a href="#tools"><span class="settings-nav-icon">⌘</span><div><strong>Tools</strong><small>Inventory and permissions</small></div></a>
			</nav>

			<div class="settings-content">
				<section id="brokers" class="settings-section">
					<header><div><span class="panel-kicker">Runtime connections</span><h2>Brokers</h2><p>Configure brokers already supplied by Nox or an installed extension.</p></div><span class="settings-count">1 available</span></header>
					<div class="capability-notice"><span aria-hidden="true">◇</span><div><strong>Extensions supply broker types</strong><p>New broker implementations are installed as app extensions. They are not created from this workbench.</p></div></div>
					<div class="capability-list">
						<div class="capability-row">
							<div class="capability-mark web">W</div>
							<div class="capability-copy"><strong>Web</strong><span>Built into Nox · Playground and local sessions</span></div>
							<span class="capability-origin">BUILT-IN</span><span class="capability-status"><i></i> Available</span>
						</div>
					</div>
					<div class="settings-footnote"><strong>No broker settings exposed</strong><p>The built-in Web broker uses the blueprint selected when a session starts. Extension-provided settings will appear in this section.</p></div>
				</section>

				<section id="tools" class="settings-section">
					<header><div><span class="panel-kicker">Runtime capabilities</span><h2>Tools</h2><p>Inspect registered tool sets and configure their application-wide permission policy.</p></div><span class="settings-count">{loading ? "…" : `${toolSets.length} registered`}</span></header>
					<div class="capability-notice"><span aria-hidden="true">◇</span><div><strong>Extensions supply tool sets</strong><p>Tool code is installed with Nox or an app extension. Blueprints decide which registered tools an agent can use.</p></div></div>

					<div class="settings-subsection">
						<div class="settings-subheading"><div><h3>Registered tool sets</h3><p>Read-only runtime inventory</p></div></div>
						{#if loading}
							<div class="capability-list">{#each [1, 2] as _}<div class="capability-row"><span class="table-skeleton short"></span><span class="table-skeleton long"></span></div>{/each}</div>
						{:else if toolSets.length === 0}
							<div class="settings-empty"><span>⌘</span><div><strong>No tool sets registered</strong><p>Installed tool extensions will appear here automatically.</p></div></div>
						{:else}
							<div class="capability-list">
								{#each toolSets as toolSet}
									<div class="capability-row"><div class="capability-mark tool">⌘</div><div class="capability-copy"><strong>{toolSet}</strong><span>Registered by the runtime</span></div><span class="capability-origin">INSTALLED</span><span class="capability-status"><i></i> Available</span></div>
								{/each}
							</div>
						{/if}
					</div>

					<form id="permissions" class="settings-subsection permission-settings" onsubmit={(event) => { event.preventDefault(); save(); }}>
						<div class="settings-subheading"><div><h3>Global permission policies</h3><p>Policies apply after the tool-specific defaults and before a call runs.</p></div><button class="button secondary" type="button" onclick={addRule} disabled={loading || saving}><span aria-hidden="true">+</span> Add policy</button></div>
						<label class="timeout-field"><span>Approval timeout</span><div class="input-suffix"><input type="number" min="1" step="1" bind:value={timeoutSeconds} disabled={loading || saving} /><b>seconds</b></div><small>Pending requests are denied when this time expires.</small></label>

						<div class="policy-list">
							{#each rules as rule, index}
								<fieldset class="policy-card">
									<legend>Policy {String(index + 1).padStart(2, "0")}</legend>
									<button class="policy-remove" type="button" onclick={() => removeRule(index)} disabled={saving} aria-label={`Remove policy ${index + 1}`}>×</button>
									<div class="field-grid policy-grid">
										<label><span>Tool calls</span><input bind:value={rule.tools} disabled={saving} placeholder="* or shell, search" /><small>Use <code>*</code> for every tool, or comma-separated call names.</small></label>
										<label><span>Action</span><select bind:value={rule.verdict} disabled={saving}><option value="escalate">Ask for approval</option><option value="deny">Always deny</option></select><small>Deny rules take precedence over approval rules.</small></label>
									</div>
									<label class="wide-field"><span>Reason shown to the user</span><input bind:value={rule.reason} disabled={saving} placeholder="Explain why this call is protected" /></label>
									<label class="wide-field"><span>Argument conditions <em>Optional JSON</em></span><input bind:value={rule.match} disabled={saving} placeholder={'{"path":"^/protected/"}'} /><small>Map argument names to regular expressions. All conditions must match.</small></label>
								</fieldset>
							{:else}
								<div class="settings-empty policy-empty"><span>✓</span><div><strong>No global policies</strong><p>Calls follow the defaults declared by each installed tool set.</p></div></div>
							{/each}
						</div>
						{#if formError}<div class="form-error" role="alert"><span>!</span><p>{formError}</p></div>{/if}
						{#if saved}<div class="settings-saved" role="status"><span>✓</span><div><strong>Tool settings saved</strong><p>Restart Nox before starting new sessions to apply the updated policies.</p></div></div>{/if}
						<div class="settings-actions"><span>Changes affect new sessions after restart.</span><button class="button primary" type="submit" disabled={loading || saving}>{saving ? "Saving…" : "Save tool settings"}</button></div>
					</form>
				</section>
			</div>
		</div>
	{/if}
</section>

<style>
	/*
	 * Settings-specific styles. Form controls and .form-error come from
	 * forms.css; .error-state from primitives.css. Rules that extend those
	 * bases (.settings-error, .permission-settings > .form-error) win on
	 * specificity once scoped.
	 */

	.settings-heading { margin-bottom: 24px; }

	.settings-layout {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		align-items: start;
		gap: 22px;
	}

	/* -------------------------------------------------------- section nav */

	.settings-nav {
		position: sticky;
		top: calc(var(--topbar-height) + 22px);
		padding: 10px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.settings-nav > span {
		display: block;
		padding: 7px 9px 9px;
		color: var(--muted);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: .08em;
		text-transform: uppercase;
	}
	.settings-nav a {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		align-items: center;
		gap: 9px;
		padding: 9px;
		border-radius: 6px;
	}
	.settings-nav a:hover { background: var(--surface-2); }
	.settings-nav-icon {
		display: grid;
		width: 28px;
		height: 28px;
		place-items: center;
		background: #1b211c;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 11px;
	}
	.settings-nav strong,
	.settings-nav small { display: block; }
	.settings-nav strong {
		font-size: 11px;
		font-weight: 590;
	}
	.settings-nav small {
		margin-top: 1px;
		color: var(--muted);
		font-size: 8px;
	}

	/* ----------------------------------------------------------- sections */

	.settings-content { min-width: 0; }
	.settings-section {
		scroll-margin-top: calc(var(--topbar-height) + 20px);
		overflow: hidden;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.settings-section + .settings-section { margin-top: 22px; }
	.settings-section > header {
		display: flex;
		min-height: 93px;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		padding: 18px 21px;
		border-bottom: 1px solid var(--border);
	}
	.settings-section > header h2 {
		margin: 2px 0 2px;
		font-size: 18px;
		font-weight: 620;
		letter-spacing: -.02em;
	}
	.settings-section > header p {
		margin: 0;
		color: var(--muted);
		font-size: 10px;
	}
	.settings-count {
		flex: 0 0 auto;
		padding: 4px 7px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}

	.settings-subsection {
		padding: 19px 20px 21px;
		border-top: 1px solid var(--border);
	}
	.settings-subheading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		margin-bottom: 13px;
	}
	.settings-subheading h3 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
	}
	.settings-subheading p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	.settings-footnote {
		margin: 0 20px 20px;
		padding: 12px;
		background: var(--surface-sunken);
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.settings-footnote strong {
		color: var(--secondary);
		font-size: 9px;
		font-weight: 580;
	}
	.settings-footnote p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	.settings-error { border-radius: 8px; }

	/* -------------------------------------------------------- capabilities */

	.capability-notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 16px 20px;
		padding: 11px 12px;
		background: #151b17;
		border: 1px solid #27332b;
		border-radius: 6px;
	}
	.capability-notice > span {
		display: grid;
		width: 21px;
		height: 21px;
		flex: 0 0 auto;
		place-items: center;
		color: var(--healthy);
		font-size: 13px;
	}
	.capability-notice strong,
	.capability-notice p { display: block; }
	.capability-notice strong {
		color: var(--secondary);
		font-size: 9px;
		font-weight: 590;
	}
	.capability-notice p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
		line-height: 1.5;
	}

	.capability-list {
		margin: 0 20px 18px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	/* Inside a subsection the list is already inset by the padding. */
	.settings-subsection .capability-list { margin: 0; }
	.capability-row {
		display: grid;
		grid-template-columns: 34px minmax(160px, 1fr) auto 92px;
		min-height: 60px;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}
	.capability-row:last-child { border-bottom: 0; }
	.capability-mark {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		background: var(--cloud-soft);
		border: 1px solid rgb(118 162 206 / 15%);
		border-radius: 7px;
		color: var(--cloud);
		font-size: 10px;
		font-weight: 650;
	}
	.capability-mark.tool {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 15%);
		color: var(--healthy);
		font-family: var(--font-mono);
	}
	.capability-copy { min-width: 0; }
	.capability-copy strong,
	.capability-copy span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.capability-copy strong {
		font-size: 11px;
		font-weight: 590;
	}
	.capability-copy span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	.capability-origin {
		padding: 3px 6px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 7px;
		letter-spacing: .045em;
	}
	.capability-status {
		color: var(--secondary);
		font-size: 8px;
		text-align: right;
	}
	.capability-status i {
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-right: 5px;
		background: var(--healthy);
		border-radius: 50%;
		box-shadow: 0 0 0 3px rgb(105 180 134 / 8%);
	}

	.settings-empty {
		display: flex;
		min-height: 76px;
		align-items: center;
		gap: 11px;
		padding: 14px;
		background: var(--surface-sunken);
		border: 1px dashed var(--border-strong);
		border-radius: 7px;
	}
	.settings-empty > span {
		display: grid;
		width: 31px;
		height: 31px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.settings-empty strong {
		font-size: 10px;
		font-weight: 580;
	}
	.settings-empty p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	/* --------------------------------------------------- permission policy */

	.permission-settings { padding-bottom: 0; }
	.permission-settings > .form-error { margin: 13px 0 0; }

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

	/* ------------------------------------------------------------ actions */

	.settings-saved {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		margin-top: 13px;
		padding: 10px 11px;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 15%);
		border-radius: 6px;
	}
	.settings-saved > span { color: var(--healthy); }
	.settings-saved strong {
		font-size: 9px;
		font-weight: 590;
	}
	.settings-saved p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	/* Negative margin lets the bar span the subsection's padding. */
	.settings-actions {
		display: flex;
		min-height: 65px;
		align-items: center;
		justify-content: flex-end;
		gap: 14px;
		margin: 19px -20px 0;
		padding: 12px 20px;
		background: var(--surface-sunken);
		border-top: 1px solid var(--border);
	}
	.settings-actions > span {
		color: var(--muted);
		font-size: 8px;
	}

	/* -------------------------------------------------------- breakpoints */

	@media (max-width: 1120px) {
		.settings-layout { grid-template-columns: 180px minmax(0, 1fr); }
	}

	@media (max-width: 900px) {
		.settings-layout { grid-template-columns: 1fr; }
		/* Nav becomes a horizontal scroller above the content. */
		.settings-nav {
			position: static;
			display: flex;
			gap: 4px;
			overflow-x: auto;
		}
		.settings-nav > span { display: none; }
		.settings-nav a { min-width: 190px; }
	}

	@media (max-width: 620px) {
		.settings-section > header { align-items: flex-start; }
		.capability-row { grid-template-columns: 34px minmax(0, 1fr) auto; }
		.capability-status { display: none; }
		.policy-grid { grid-template-columns: 1fr; }
		.settings-actions {
			align-items: stretch;
			flex-direction: column;
		}
		.settings-actions .button { width: 100%; }
	}
</style>
