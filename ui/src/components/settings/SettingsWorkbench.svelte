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
