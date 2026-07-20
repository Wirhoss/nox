<script lang="ts">
	import { onMount } from "svelte";

	type ModelConfig = {
		modelId: string;
		type: "text";
		contextWindow?: number;
	};
	type Provider = {
		id: string;
		type: "openai_completions";
		status: "active" | "inactive";
		baseUrl: string;
		hasApiKey: boolean;
		defaultModel?: string;
		timeoutMs?: number;
		modelConfigs?: ModelConfig[];
	};
	type ProviderDraft = Omit<Provider, "id" | "status" | "hasApiKey"> & {
		id: string;
		modelConfigs: ModelConfig[];
	};
	type ProviderMutation = { provider: Provider; restartRequired: boolean };
	type ApiError = { error?: { message?: string }; message?: string };

	export let view: "library" | "new" | "edit" = "library";

	let providers: Provider[] = [];
	let liveModels: Record<string, ModelConfig[]> = {};
	let loading = true;
	let saving = false;
	let deleting = false;
	let errorMessage = "";
	let formError = "";
	let query = "";
	let originalId = "";
	let deleteOpen = false;
	let newApiKey = "";
	let clearApiKey = false;
	let storedApiKey = false;
	let restartNotice = false;
	let draft = emptyDraft();

	function emptyDraft(): ProviderDraft {
		return {
			id: "",
			type: "openai_completions",
			baseUrl: "",
			modelConfigs: [],
		};
	}

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
			throw new Error(
				body.error?.message ?? body.message ?? `${response.status} ${response.statusText}`,
			);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	const load = async () => {
		loading = true;
		errorMessage = "";
		try {
			providers = await request<Provider[]>("/api/v1/providers");
			if (view === "library") {
				restartNotice = new URLSearchParams(window.location.search).has("restart");
				const results = await Promise.allSettled(
					providers.map((provider) =>
						request<ModelConfig[]>(`/api/v1/providers/${encodeURIComponent(provider.id)}/models`),
					),
				);
				const nextLiveModels: Record<string, ModelConfig[]> = {};
				for (const [index, provider] of providers.entries()) {
					const result = results[index];
					nextLiveModels[provider.id] = result?.status === "fulfilled"
						? result.value
						: (provider.modelConfigs ?? []);
				}
				liveModels = nextLiveModels;
			}
			if (view === "edit") {
				const id = new URLSearchParams(window.location.search).get("id");
				if (!id) throw new Error("No provider was selected for editing.");
				const provider = providers.find((item) => item.id === id)
					?? await request<Provider>(`/api/v1/providers/${encodeURIComponent(id)}`);
				draft = {
					id: provider.id,
					type: provider.type,
					baseUrl: provider.baseUrl,
					defaultModel: provider.defaultModel,
					timeoutMs: provider.timeoutMs,
					modelConfigs: structuredClone(provider.modelConfigs ?? []),
				};
				originalId = provider.id;
				storedApiKey = provider.hasApiKey;
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "Provider data could not be loaded.";
		} finally {
			loading = false;
		}
	};

	const addModel = () => {
		draft.modelConfigs = [...draft.modelConfigs, { modelId: "", type: "text" }];
	};

	const removeModel = (index: number) => {
		draft.modelConfigs = draft.modelConfigs.filter((_, modelIndex) => modelIndex !== index);
	};

	const validate = () => {
		if (!draft.id.trim()) return "Give this provider an ID.";
		if (!/^[a-zA-Z0-9_-]+$/.test(draft.id))
			return "Use only letters, numbers, hyphens, and underscores in the ID.";
		if (!draft.baseUrl.trim()) return "Add the provider base URL.";
		try {
			new URL(draft.baseUrl);
		} catch {
			return "Enter a valid absolute base URL.";
		}
		if (draft.timeoutMs !== undefined && (!Number.isFinite(draft.timeoutMs) || draft.timeoutMs <= 0))
			return "Timeout must be greater than zero.";
		const modelIds = draft.modelConfigs.map((model) => model.modelId.trim());
		if (modelIds.some((id) => !id)) return "Every configured model needs an ID.";
		if (new Set(modelIds).size !== modelIds.length) return "Model IDs must be unique.";
		if (draft.modelConfigs.some((model) => model.contextWindow !== undefined
			&& (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)))
			return "Context windows must be positive whole numbers.";
		return "";
	};

	const save = async () => {
		formError = validate();
		if (formError) return;
		saving = true;
		try {
			const config = {
				type: draft.type,
				baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
				...(newApiKey ? { apiKey: newApiKey } : clearApiKey ? { apiKey: "" } : {}),
				...(draft.defaultModel?.trim() ? { defaultModel: draft.defaultModel.trim() } : {}),
				...(draft.timeoutMs ? { timeoutMs: draft.timeoutMs } : {}),
				...(draft.modelConfigs.length > 0 ? {
					modelConfigs: draft.modelConfigs.map((model) => ({
						type: "text" as const,
						modelId: model.modelId.trim(),
						...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
					})),
				} : {}),
			};
			const path = view === "new"
				? "/api/v1/providers"
				: `/api/v1/providers/${encodeURIComponent(originalId)}`;
			await request<ProviderMutation>(path, {
				method: view === "new" ? "POST" : "PUT",
				body: JSON.stringify(view === "new" ? { id: draft.id.trim(), config } : config),
			});
			window.location.assign("/providers?restart=1");
		} catch (error) {
			formError = error instanceof Error ? error.message : "The provider could not be saved.";
		} finally {
			saving = false;
		}
	};

	const remove = async () => {
		deleting = true;
		formError = "";
		try {
			await request<ProviderMutation>(`/api/v1/providers/${encodeURIComponent(originalId)}`, {
				method: "DELETE",
			});
			window.location.assign("/providers?restart=1");
		} catch (error) {
			formError = error instanceof Error ? error.message : "The provider could not be deleted.";
			deleteOpen = false;
		} finally {
			deleting = false;
		}
	};

	const prettyType = (value: string) => value
		.replaceAll("_", " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
	const hostLabel = (baseUrl: string) => {
		try {
			return new URL(baseUrl).host;
		} catch {
			return baseUrl;
		}
	};

	$: filteredProviders = providers.filter((provider) =>
		`${provider.id} ${provider.type} ${provider.baseUrl}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	);
	$: identityValid = Boolean(draft.id && /^[a-zA-Z0-9_-]+$/.test(draft.id));
	$: endpointValid = (() => {
		try {
			return Boolean(new URL(draft.baseUrl));
		} catch {
			return false;
		}
	})();
	$: credentialsReady = Boolean(newApiKey || (storedApiKey && !clearApiKey));
	$: configuredModelCount = draft.modelConfigs.filter((model) => model.modelId.trim()).length;

	onMount(load);
</script>

{#if view === "library"}
	<section class="providers-page">
		<header class="page-heading workbench-heading">
			<div>
				<div class="eyebrow">Build</div>
				<h1>Providers</h1>
				<p>Model endpoints, credentials, and runtime availability.</p>
			</div>
			<a class="button primary" href="/providers/new"><span aria-hidden="true">+</span> Add provider</a>
		</header>

		{#if restartNotice}
			<div class="restart-banner" role="status">
				<span class="restart-icon" aria-hidden="true">↻</span>
				<div><strong>Restart Nox to apply provider changes</strong><p>The configuration is saved locally. Runtime status and discovered models update after restart.</p></div>
				<button type="button" aria-label="Dismiss restart notice" onclick={() => (restartNotice = false)}>×</button>
			</div>
		{/if}

		<div class="library-toolbar provider-toolbar">
			<label class="library-search">
				<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
				<input bind:value={query} placeholder="Search providers…" aria-label="Search providers" />
			</label>
			<span class="library-count">{loading ? "Loading" : `${filteredProviders.length} of ${providers.length}`}</span>
		</div>

		{#if errorMessage}
			<div class="error-state">
				<div class="error-symbol">!</div><strong>Providers unavailable</strong><p>{errorMessage}</p>
				<button class="button secondary" type="button" onclick={load}>Try again</button>
			</div>
		{:else if loading}
			<div class="provider-grid provider-loading" aria-label="Loading providers">
				{#each [1, 2, 3] as _}<div class="provider-card"><span class="table-skeleton short"></span><span class="table-skeleton long"></span><span class="table-skeleton"></span></div>{/each}
			</div>
		{:else if providers.length === 0}
			<div class="library-empty provider-empty">
				<div class="provider-empty-mark"><span></span><span></span><span></span></div>
				<span class="panel-kicker">No model endpoints configured</span>
				<h2>Connect your first provider</h2>
				<p>Add an OpenAI-compatible local or cloud endpoint, then choose its models in a blueprint.</p>
				<a class="button primary" href="/providers/new">Add provider</a>
			</div>
		{:else if filteredProviders.length === 0}
			<div class="library-empty compact-empty">
				<div class="empty-search">?</div><h2>No matching providers</h2><p>Try an ID, endpoint, or provider type.</p>
				<button class="button secondary" type="button" onclick={() => (query = "")}>Clear search</button>
			</div>
		{:else}
			<div class="provider-grid">
				{#each filteredProviders as provider}
					<a class="provider-card" href={`/providers/edit?id=${encodeURIComponent(provider.id)}`}>
						<div class="provider-card-top">
							<span class="provider-card-mark" aria-hidden="true">{provider.id.slice(0, 2).toUpperCase()}</span>
							<span class:active={provider.status === "active"} class="provider-status"><i></i>{provider.status}</span>
						</div>
						<div class="provider-card-copy"><h2>{provider.id}</h2><p>{hostLabel(provider.baseUrl)}</p></div>
						<div class="provider-card-facts">
							<div><span>Protocol</span><strong>{prettyType(provider.type)}</strong></div>
							<div><span>Models</span><strong>{(liveModels[provider.id] ?? provider.modelConfigs ?? []).length}</strong></div>
							<div><span>Credential</span><strong>{provider.hasApiKey ? "Stored" : "None"}</strong></div>
						</div>
						<span class="provider-card-action">Configure <span aria-hidden="true">→</span></span>
					</a>
				{/each}
			</div>
		{/if}
	</section>
{:else}
	<section class="workbench-editor provider-editor">
		<header class="editor-titlebar">
			<div>
				<a class="back-link" href="/providers">← Providers</a>
				<div class="editor-title">
					<span class="editor-mark provider-editor-mark">{view === "new" ? "+" : draft.id.slice(0, 2).toUpperCase()}</span>
					<div><span class="eyebrow">{view === "new" ? "New connection" : "Provider configuration"}</span><h1>{view === "new" ? "Add provider" : loading ? "Loading provider…" : draft.id}</h1></div>
				</div>
			</div>
			<div class="editor-actions">
				{#if view === "edit"}<button class="button danger-outline" type="button" onclick={() => (deleteOpen = true)} disabled={loading}>Delete</button>{/if}
				<a class="button secondary" href="/providers">Cancel</a>
				<button class="button primary" type="button" onclick={save} disabled={loading || saving}>{saving ? "Saving…" : view === "new" ? "Add provider" : "Save changes"}</button>
			</div>
		</header>

		{#if errorMessage && !loading}
			<div class="error-state"><div class="error-symbol">!</div><strong>Editor unavailable</strong><p>{errorMessage}</p><a class="button secondary" href="/providers">Back to providers</a></div>
		{:else}
			<div class="editor-grid" class:editor-loading={loading}>
				<nav class="editor-sections" aria-label="Provider sections">
					<span class="editor-nav-label">Configuration</span>
					<a class="active" href="#connection">Connection</a><a href="#credentials">Credentials</a><a href="#models">Models <span>{configuredModelCount}</span></a>
				</nav>

				<form class="editor-form" onsubmit={(event) => { event.preventDefault(); save(); }}>
					<section id="connection" class="form-section">
						<header><span>01</span><div><h2>Connection</h2><p>Identify the endpoint Nox uses for model requests.</p></div></header>
						<div class="field-grid two">
							<label><span>Provider ID</span><input bind:value={draft.id} disabled={view === "edit" || loading} placeholder="local-llama" autocomplete="off" /><small>Stable ID used by blueprints and sessions.</small></label>
							<label><span>Protocol</span><select bind:value={draft.type} disabled={loading}><option value="openai_completions">OpenAI completions</option></select><small>Works with OpenAI-compatible endpoints.</small></label>
						</div>
						<label class="wide-field"><span>Base URL</span><input bind:value={draft.baseUrl} disabled={loading} placeholder="http://localhost:11434/v1" inputmode="url" /><small>Include the API prefix expected before <code>/models</code> and <code>/chat/completions</code>.</small></label>
						<div class="field-grid two provider-options">
							<label><span>Default model <em>Optional</em></span><input bind:value={draft.defaultModel} disabled={loading} placeholder="model-id" /><small>Used when a run does not select one explicitly.</small></label>
							<label><span>Request timeout <em>Optional</em></span><div class="input-suffix"><input type="number" min="1" bind:value={draft.timeoutMs} disabled={loading} placeholder="30000" /><b>ms</b></div><small>Leave empty to use the runtime default.</small></label>
						</div>
					</section>

					<section id="credentials" class="form-section">
						<header><span>02</span><div><h2>Credentials</h2><p>Secrets are written to the local provider configuration.</p></div></header>
						<div class="credential-field">
							<label><span>API key <em>Optional</em></span><input type="password" bind:value={newApiKey} disabled={loading || clearApiKey} autocomplete="new-password" placeholder={storedApiKey ? "Stored key — enter to replace" : "Not required for many local endpoints"} /><small>{storedApiKey && !clearApiKey ? "A credential is currently stored. Its value is never returned to the browser." : "No credential will be sent unless you provide one."}</small></label>
							{#if storedApiKey}<button class:marked={clearApiKey} class="credential-clear" type="button" onclick={() => { clearApiKey = !clearApiKey; newApiKey = ""; }}>{clearApiKey ? "Keep stored key" : "Remove stored key"}</button>{/if}
						</div>
					</section>

					<section id="models" class="form-section">
						<header><span>03</span><div><h2>Model overrides</h2><p>Optionally define context limits for known models.</p></div><span class="section-count">{configuredModelCount} configured</span></header>
						<div class="model-editor">
							<div class="model-editor-head"><span>Model ID</span><span>Context window</span><span></span></div>
							{#each draft.modelConfigs as model, index}
								<div class="model-editor-row">
									<div><input bind:value={model.modelId} disabled={loading} placeholder="model-id" aria-label={`Model ${index + 1} ID`} /><span class="model-kind">TEXT</span></div>
									<div class="input-suffix"><input type="number" min="1" step="1" bind:value={model.contextWindow} disabled={loading} placeholder="Auto" aria-label={`Context window for model ${index + 1}`} /><b>tokens</b></div>
									<button type="button" onclick={() => removeModel(index)} disabled={loading} aria-label={`Remove model ${model.modelId || index + 1}`}>×</button>
								</div>
							{:else}
								<div class="model-editor-empty"><strong>No model overrides</strong><span>Active providers discover available model IDs when Nox starts.</span></div>
							{/each}
						</div>
						<button class="button secondary add-model" type="button" onclick={addModel} disabled={loading}><span aria-hidden="true">+</span> Add model override</button>
					</section>
					<button class="visually-hidden" type="submit">Save provider</button>
				</form>

				<aside class="validation-panel"><div class="validation-sticky">
					<span class="panel-kicker">Connection check</span><h2>Configuration</h2>
					<div class="validation-list">
						<div class:valid={identityValid}><span>{identityValid ? "✓" : "·"}</span><div><strong>Identity</strong><small>{identityValid ? draft.id : "Valid provider ID"}</small></div></div>
						<div class:valid={endpointValid}><span>{endpointValid ? "✓" : "·"}</span><div><strong>Endpoint</strong><small>{endpointValid ? hostLabel(draft.baseUrl) : "Absolute URL required"}</small></div></div>
						<div class:valid={credentialsReady}><span>{credentialsReady ? "✓" : "·"}</span><div><strong>Credential</strong><small>{credentialsReady ? "Will be stored" : "Optional"}</small></div></div>
						<div class="valid"><span>✓</span><div><strong>Models</strong><small>{configuredModelCount ? `${configuredModelCount} overrides` : "Discover on restart"}</small></div></div>
					</div>
					{#if formError}<div class="form-error" role="alert"><span>!</span><p>{formError}</p></div>{/if}
					<div class="validation-note restart-note"><strong>Restart required after saving</strong><p>Provider instances and model discovery are initialized when Nox starts.</p></div>
				</div></aside>
			</div>
		{/if}

		{#if deleteOpen}
			<div class="dialog-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) deleteOpen = false; }}>
				<div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-provider-title">
					<div class="dialog-danger-mark">!</div><h2 id="delete-provider-title">Delete “{draft.id}”?</h2>
					<p>This removes the provider configuration and stored credential. Deletion is blocked while a blueprint still references it.</p>
					<div class="dialog-actions"><button class="button secondary" type="button" onclick={() => (deleteOpen = false)}>Cancel</button><button class="button danger" type="button" onclick={remove} disabled={deleting}>{deleting ? "Deleting…" : "Delete provider"}</button></div>
				</div>
			</div>
		{/if}
	</section>
{/if}

<style>
	/*
	 * Provider-specific styles only. The library toolbar, editor grid, form
	 * controls and validation panel are shared with the blueprint workbench
	 * and live in src/styles/workbench.css and forms.css.
	 *
	 * Several rules here intentionally override a global base by being more
	 * specific once scoped (.provider-empty over .library-empty, .restart-note
	 * over .validation-note, .provider-toolbar over .library-toolbar).
	 */

	/* ------------------------------------------------------ restart banner */

	.restart-banner {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr) 28px;
		align-items: center;
		gap: 11px;
		margin-bottom: 12px;
		padding: 11px 12px;
		background: linear-gradient(100deg, #272116, #1b1913);
		border: 1px solid #443a26;
		border-radius: 8px;
	}
	.restart-icon {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 19%);
		border-radius: 7px;
		color: var(--accent);
		font-size: 16px;
	}
	.restart-banner strong,
	.restart-banner p { display: block; }
	.restart-banner strong {
		font-size: 11px;
		font-weight: 600;
	}
	.restart-banner p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 9px;
	}
	.restart-banner > button {
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 5px;
		color: var(--muted);
		cursor: pointer;
		font-size: 18px;
	}
	.restart-banner > button:hover {
		background: rgb(255 255 255 / 4%);
		color: var(--text);
	}

	/* --------------------------------------------------------- card library */

	/* Providers use cards rather than the blueprint table, so the toolbar
	   closes itself off instead of butting against a table below. */
	.provider-toolbar {
		border-bottom: 1px solid var(--border);
		border-radius: 8px;
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(250px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}
	.provider-card {
		position: relative;
		min-width: 0;
		min-height: 242px;
		padding: 17px;
		overflow: hidden;
		background: linear-gradient(145deg, rgb(20 26 22 / 97%), rgb(15 19 16 / 97%));
		border: 1px solid var(--border);
		border-radius: 8px;
		transition: border-color 130ms ease, transform 130ms ease, background 130ms ease;
	}
	a.provider-card:hover {
		background: linear-gradient(145deg, #171d18, var(--surface-raised));
		border-color: #39443c;
		transform: translateY(-1px);
	}
	/* Decorative corner glow. */
	.provider-card::after {
		position: absolute;
		top: -65px;
		right: -50px;
		width: 160px;
		height: 160px;
		background: radial-gradient(circle, rgb(105 180 134 / 7%), transparent 67%);
		content: '';
		pointer-events: none;
	}
	.provider-loading .provider-card {
		display: flex;
		min-height: 242px;
		flex-direction: column;
		gap: 28px;
		justify-content: flex-start;
	}

	.provider-card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.provider-card-mark,
	.provider-editor-mark {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 18%);
		color: #91b5d6;
	}
	.provider-card-mark {
		display: grid;
		width: 38px;
		height: 38px;
		place-items: center;
		border: 1px solid rgb(118 162 206 / 18%);
		border-radius: 8px;
		font-size: 10px;
		font-weight: 700;
	}
	.provider-status {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #c98580;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: capitalize;
	}
	.provider-status i {
		display: block;
		width: 6px;
		height: 6px;
		background: var(--danger);
		border-radius: 50%;
		box-shadow: 0 0 0 3px rgb(216 120 114 / 8%);
	}
	.provider-status.active { color: #83bc97; }
	.provider-status.active i {
		background: var(--healthy);
		box-shadow: 0 0 0 3px rgb(105 180 134 / 9%);
	}

	.provider-card-copy { margin-top: 22px; }
	.provider-card-copy h2 {
		margin: 0;
		overflow: hidden;
		font-size: 15px;
		font-weight: 590;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-copy p {
		margin: 4px 0 0;
		overflow: hidden;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 9px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-facts {
		display: grid;
		grid-template-columns: 1.45fr .65fr .8fr;
		gap: 8px;
		margin-top: 19px;
		padding: 12px 0;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.provider-card-facts span,
	.provider-card-facts strong { display: block; }
	.provider-card-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.provider-card-facts strong {
		margin-top: 3px;
		overflow: hidden;
		font-size: 9px;
		font-weight: 560;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-card-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 13px;
		color: var(--secondary);
		font-size: 10px;
	}
	.provider-card-action span {
		color: var(--muted);
		font-size: 14px;
		transition: transform 120ms ease, color 120ms ease;
	}
	a.provider-card:hover .provider-card-action span {
		color: var(--accent);
		transform: translateX(2px);
	}

	/* Three offset tiles standing in for provider cards; the third is dashed
	   to read as "add one". Decorative — shown on the empty library. */
	.provider-empty {
		margin-top: 12px;
		border-radius: 8px;
	}
	.provider-empty-mark {
		position: relative;
		width: 58px;
		height: 52px;
		margin-bottom: 21px;
	}
	.provider-empty-mark span {
		position: absolute;
		display: block;
		width: 28px;
		height: 28px;
		background: var(--cloud-soft);
		border: 1px solid rgb(118 162 206 / 17%);
		border-radius: 7px;
	}
	.provider-empty-mark span:nth-child(1) { top: 0; left: 0; }
	.provider-empty-mark span:nth-child(2) { top: 0; right: 0; }
	.provider-empty-mark span:nth-child(3) {
		bottom: 0;
		left: 15px;
		background: var(--surface-2);
		border-style: dashed;
	}

	/* --------------------------------------------------------------- editor */

	.wide-field {
		display: block;
		margin-top: 17px;
	}
	.provider-options { margin-top: 17px; }

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

	/* Amber variant of the shared validation note, for restart-required copy. */
	.restart-note {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 14%);
	}
	.restart-note strong { color: #d6b679; }

	/* --------------------------------------------------------- breakpoints */

	@media (max-width: 1120px) {
		.provider-grid { grid-template-columns: repeat(2, minmax(250px, 1fr)); }
	}

	@media (max-width: 900px) {
		.provider-grid { grid-template-columns: 1fr; }
	}

	@media (max-width: 620px) {
		/* Drop the dismiss button; the banner clears itself on restart. */
		.restart-banner { grid-template-columns: 32px minmax(0, 1fr); }
		.restart-banner > button { display: none; }
		.provider-card { min-height: 230px; }
		.credential-field { grid-template-columns: 1fr; }
		.credential-clear {
			width: max-content;
			margin-top: 0;
		}
		.model-editor-head { display: none; }
		.model-editor-row {
			grid-template-columns: 1fr 28px;
			padding: 10px;
		}
		.model-editor-row .input-suffix { grid-column: 1; }
		.model-editor-row > button {
			grid-row: 1 / 3;
			grid-column: 2;
		}
	}
</style>
