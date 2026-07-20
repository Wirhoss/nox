<script lang="ts">
	import { onMount } from "svelte";
	import Avatar from "../shared/Avatar.svelte";

	type Model = { modelId: string; type: string; contextWindow?: number };
	type Provider = {
		id: string;
		type: string;
		status: "active" | "inactive";
		baseUrl: string;
		modelConfigs?: Model[];
	};
	type Blueprint = {
		id: string;
		description: string;
		systemPrompt: string;
		coreTools: string[];
		lazyLoadedTools: string[];
		config: { providerId: string; modelId: string; maxIterations: number };
	};
	type EditorDraft = Blueprint;
	type ApiError = { error?: { message?: string }; message?: string };

	export let view: "library" | "new" | "edit" = "library";

	let blueprints: Blueprint[] = [];
	let providers: Provider[] = [];
	let modelsByProvider: Record<string, Model[]> = {};
	let unavailableModelProviders = new Set<string>();
	let tools: string[] = [];
	let loading = true;
	let saving = false;
	let deleting = false;
	let errorMessage = "";
	let formError = "";
	let query = "";
	let deleteOpen = false;
	let originalId = "";
	let draft: EditorDraft = emptyDraft();
	let availableModels: Model[] = [];
	let selectableModels: Model[] = [];

	function emptyDraft(): EditorDraft {
		return {
			id: "",
			description: "",
			systemPrompt: "",
			coreTools: [],
			lazyLoadedTools: [],
			config: { providerId: "", modelId: "", maxIterations: 90 },
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
				body.error?.message ??
					body.message ??
					`${response.status} ${response.statusText}`,
			);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	const load = async () => {
		loading = true;
		errorMessage = "";
		try {
			const [blueprintData, providerData, toolData] = await Promise.all([
				request<Blueprint[]>("/api/v1/blueprints"),
				request<Provider[]>("/api/v1/providers"),
				request<string[]>("/api/v1/tools"),
			]);
			blueprints = blueprintData;
			providers = providerData;
			tools = toolData;

			const modelResults = await Promise.allSettled(
				providerData.map((provider) =>
					request<Model[]>(
						`/api/v1/providers/${encodeURIComponent(provider.id)}/models`,
					),
				),
			);
			const nextModelsByProvider: Record<string, Model[]> = {};
			const nextUnavailableModelProviders = new Set<string>();
			for (const [index, provider] of providerData.entries()) {
				const result = modelResults[index];
				const models =
					result?.status === "fulfilled"
						? result.value
						: (provider.modelConfigs ?? []);
				nextModelsByProvider[provider.id] = [...models].sort((left, right) =>
					left.modelId.localeCompare(right.modelId),
				);
				if (result?.status !== "fulfilled")
					nextUnavailableModelProviders.add(provider.id);
			}
			modelsByProvider = nextModelsByProvider;
			unavailableModelProviders = nextUnavailableModelProviders;

			if (view === "edit") {
				const id = new URLSearchParams(window.location.search).get("id");
				if (!id) throw new Error("No blueprint was selected for editing.");
				const blueprint =
					blueprintData.find((item) => item.id === id) ??
					(await request<Blueprint>(
						`/api/v1/blueprints/${encodeURIComponent(id)}`,
					));
				draft = structuredClone(blueprint);
				originalId = blueprint.id;
			} else if (view === "new") {
				draft = emptyDraft();
				if (providerData.length === 1)
					draft.config.providerId = providerData[0]!.id;
				const availableModels = modelsForProvider(draft.config.providerId);
				if (availableModels.length === 1)
					draft.config.modelId = availableModels[0]!.modelId;
			}
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "The workbench data could not be loaded.";
		} finally {
			loading = false;
		}
	};

	const modelsForProvider = (providerId: string) =>
		modelsByProvider[providerId] ??
		providers.find((provider) => provider.id === providerId)?.modelConfigs ??
		[];
	const toolMode = (id: string) =>
		draft.coreTools.includes(id)
			? "core"
			: draft.lazyLoadedTools.includes(id)
				? "lazy"
				: "off";
	const setToolMode = (id: string, mode: string) => {
		draft.coreTools = draft.coreTools.filter((tool) => tool !== id);
		draft.lazyLoadedTools = draft.lazyLoadedTools.filter((tool) => tool !== id);
		if (mode === "core") draft.coreTools = [...draft.coreTools, id];
		if (mode === "lazy") draft.lazyLoadedTools = [...draft.lazyLoadedTools, id];
	};
	const onProviderChange = () => {
		const availableModels = modelsForProvider(draft.config.providerId);
		if (
			!availableModels.some((model) => model.modelId === draft.config.modelId)
		) {
			draft.config.modelId =
				availableModels.length === 1 ? availableModels[0]!.modelId : "";
		}
	};

	const validate = () => {
		if (!draft.id.trim()) return "Give this blueprint an ID.";
		if (!/^[a-zA-Z0-9_-]+$/.test(draft.id))
			return "Use only letters, numbers, hyphens, and underscores in the ID.";
		if (!draft.description.trim()) return "Add a short description.";
		if (!draft.systemPrompt.trim()) return "Add system instructions.";
		if (!draft.config.providerId) return "Select a provider.";
		if (!draft.config.modelId) return "Select a model.";
		if (
			!Number.isInteger(draft.config.maxIterations) ||
			draft.config.maxIterations < 1
		)
			return "Max iterations must be a positive whole number.";
		return "";
	};

	const save = async () => {
		formError = validate();
		if (formError) return;
		saving = true;
		try {
			const path =
				view === "new"
					? "/api/v1/blueprints"
					: `/api/v1/blueprints/${encodeURIComponent(originalId)}`;
			await request<Blueprint>(path, {
				method: view === "new" ? "POST" : "PUT",
				body: JSON.stringify(draft),
			});
			window.location.assign("/blueprints");
		} catch (error) {
			formError =
				error instanceof Error
					? error.message
					: "The blueprint could not be saved.";
		} finally {
			saving = false;
		}
	};

	const remove = async () => {
		deleting = true;
		formError = "";
		try {
			await request<void>(
				`/api/v1/blueprints/${encodeURIComponent(originalId)}`,
				{ method: "DELETE" },
			);
			window.location.assign("/blueprints");
		} catch (error) {
			formError =
				error instanceof Error
					? error.message
					: "The blueprint could not be deleted.";
			deleteOpen = false;
		} finally {
			deleting = false;
		}
	};

	const prettyType = (value: string) =>
		value
			.replaceAll("_", " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase());
	$: filteredBlueprints = blueprints.filter((blueprint) =>
		`${blueprint.id} ${blueprint.description} ${blueprint.config.providerId} ${blueprint.config.modelId}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	);
	$: assignedToolCount = draft.coreTools.length + draft.lazyLoadedTools.length;
	$: selectedProvider = providers.find(
		(provider) => provider.id === draft.config.providerId,
	);
	$: availableModels = modelsByProvider[draft.config.providerId]
		?? providers.find((provider) => provider.id === draft.config.providerId)?.modelConfigs
		?? [];
	$: selectableModels =
		draft.config.modelId &&
		!availableModels.some((model) => model.modelId === draft.config.modelId)
			? [...availableModels, { modelId: draft.config.modelId, type: "text" }]
			: availableModels;

	onMount(load);
</script>

{#if view === "library"}
	<section class="blueprints-page">
		<header class="page-heading workbench-heading">
			<div>
				<div class="eyebrow">Build</div>
				<h1>Blueprints</h1>
				<p>
					Reusable definitions for agent behavior, models, and capabilities.
				</p>
			</div>
			<a class="button primary" href="/blueprints/new"
				><span aria-hidden="true">+</span> New blueprint</a
			>
		</header>

		<div class="library-toolbar">
			<label class="library-search"
				><svg aria-hidden="true" viewBox="0 0 24 24"
					><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"
					></path></svg
				><input
					bind:value={query}
					placeholder="Search blueprints…"
					aria-label="Search blueprints"
				/></label
			>
			<span class="library-count"
				>{loading
					? "Loading"
					: `${filteredBlueprints.length} of ${blueprints.length}`}</span
			>
		</div>

		{#if errorMessage}
			<div class="error-state">
				<div class="error-symbol">!</div>
				<strong>Blueprints unavailable</strong>
				<p>{errorMessage}</p>
				<button class="button secondary" type="button" onclick={load}
					>Try again</button
				>
			</div>
		{:else if loading}
			<div
				class="blueprint-table blueprint-loading"
				aria-label="Loading blueprints"
			>
				<div class="blueprint-table-head">
					<span>Name</span><span>Provider / model</span><span>Tools</span><span
						>Iterations</span
					><span></span>
				</div>
				{#each [1, 2, 3] as _}<div class="blueprint-row">
						<span class="table-skeleton long"></span><span
							class="table-skeleton"
						></span><span class="table-skeleton short"></span><span
							class="table-skeleton short"
						></span><span></span>
					</div>{/each}
			</div>
		{:else if blueprints.length === 0}
			<div class="library-empty">
				<div class="blueprint-glyph">
					<span></span><span></span><span></span><span></span>
				</div>
				<span class="panel-kicker">Your blueprint library is empty</span>
				<h2>Create the first agent definition</h2>
				<p>
					Choose a provider and model, write its core instructions, then decide
					which tools it can use.
				</p>
				<a class="button primary" href="/blueprints/new">Create blueprint</a>
			</div>
		{:else if filteredBlueprints.length === 0}
			<div class="library-empty compact-empty">
				<div class="empty-search">?</div>
				<h2>No matching blueprints</h2>
				<p>Try a name, purpose, provider, or model.</p>
				<button
					class="button secondary"
					type="button"
					onclick={() => (query = "")}>Clear search</button
				>
			</div>
		{:else}
			<div class="blueprint-table">
				<div class="blueprint-table-head">
					<span>Name</span><span>Provider / model</span><span>Tools</span><span
						>Iterations</span
					><span></span>
				</div>
				{#each filteredBlueprints as blueprint}
					<a
						class="blueprint-row"
						href={`/blueprints/edit?id=${encodeURIComponent(blueprint.id)}`}
					>
						<div class="blueprint-identity">
							<Avatar kind="blueprint" seed={`blueprint:${blueprint.id}`} label={blueprint.id} size={35} />
							<div>
								<strong>{blueprint.id}</strong><span
									>{blueprint.description}</span
								>
							</div>
						</div>
						<div class="provider-model">
							<strong>{blueprint.config.modelId}</strong><span
								>{blueprint.config.providerId}</span
							>
						</div>
						<div class="tool-summary">
							<strong
								>{blueprint.coreTools.length +
									blueprint.lazyLoadedTools.length}</strong
							><span
								>{blueprint.coreTools.length} core · {blueprint.lazyLoadedTools
									.length} lazy</span
							>
						</div>
						<div class="iteration-value">
							<strong>{blueprint.config.maxIterations}</strong><span
								>max turns</span
							>
						</div>
						<span class="row-arrow" aria-hidden="true">→</span>
					</a>
				{/each}
			</div>
		{/if}
	</section>
{:else}
	<section class="workbench-editor">
		<header class="editor-titlebar">
			<div>
				<a class="back-link" href="/blueprints">← Blueprints</a>
				<div class="editor-title">
					{#if view === "new"}<span class="editor-mark">+</span>{:else}<Avatar kind="blueprint" seed={`blueprint:${draft.id}`} label={draft.id} size={39} />{/if}
					<div>
						<span class="eyebrow"
							>{view === "new" ? "New definition" : "Blueprint editor"}</span
						>
						<h1>
							{view === "new"
								? "Create blueprint"
								: loading
									? "Loading blueprint…"
									: draft.id}
						</h1>
					</div>
				</div>
			</div>
			<div class="editor-actions">
				{#if view === "edit"}<button
						class="button danger-outline"
						type="button"
						onclick={() => (deleteOpen = true)}
						disabled={loading}>Delete</button
					><a class="button secondary playground-launch" href={`/playground?blueprint=${encodeURIComponent(draft.id)}`}>Test in Playground</a>{/if}<a class="button secondary" href="/blueprints">Cancel</a><button
					class="button primary"
					type="button"
					onclick={save}
					disabled={loading || saving}
					>{saving
						? "Saving…"
						: view === "new"
							? "Create blueprint"
							: "Save changes"}</button
				>
			</div>
		</header>

		{#if errorMessage && loading === false}
			<div class="error-state">
				<div class="error-symbol">!</div>
				<strong>Editor unavailable</strong>
				<p>{errorMessage}</p>
				<a class="button secondary" href="/blueprints">Back to library</a>
			</div>
		{:else}
			<div class="editor-grid" class:editor-loading={loading}>
				<nav class="editor-sections" aria-label="Blueprint sections">
					<span class="editor-nav-label">Configuration</span><a
						class="active"
						href="#general">General</a
					><a href="#instructions">Instructions</a><a href="#runtime"
						>Provider & model</a
					><a href="#tools">Tools <span>{assignedToolCount}</span></a><a
						href="#limits">Limits</a
					>
				</nav>

				<form
					class="editor-form"
					onsubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<section id="general" class="form-section">
						<header>
							<span>01</span>
							<div>
								<h2>General</h2>
								<p>Name and describe this reusable agent definition.</p>
							</div>
						</header>
						<div class="field-grid two">
							<label
								><span>Blueprint ID</span><input
									bind:value={draft.id}
									disabled={view === "edit" || loading}
									placeholder="researcher"
									autocomplete="off"
								/><small>Letters, numbers, hyphens, and underscores.</small
								></label
							><label
								><span>Description</span><input
									bind:value={draft.description}
									disabled={loading}
									placeholder="Researches and verifies technical claims"
								/></label
							>
						</div>
					</section>

					<section id="instructions" class="form-section">
						<header>
							<span>02</span>
							<div>
								<h2>Instructions</h2>
								<p>Define the behavior that every session starts with.</p>
							</div>
						</header>
						<label
							><span>System instructions</span><textarea
								bind:value={draft.systemPrompt}
								disabled={loading}
								rows="9"
								placeholder="You investigate claims, cite evidence, and make uncertainty explicit…"
							></textarea><small
								>{draft.systemPrompt.length.toLocaleString()} characters</small
							></label
						>
					</section>

					<section id="runtime" class="form-section">
						<header>
							<span>03</span>
							<div>
								<h2>Provider & model</h2>
								<p>Choose where this blueprint runs.</p>
							</div>
						</header>
						{#if providers.length === 0 && !loading}<div class="form-callout">
								<strong>No providers configured</strong><span
									>A provider is required before this blueprint can be saved.</span
								>
							</div>{/if}
						<div class="field-grid two">
							<label
								><span>Provider</span><select
									bind:value={draft.config.providerId}
									onchange={onProviderChange}
									disabled={loading}
									><option value="">Select provider…</option
									>{#each providers as provider}<option value={provider.id}
											>{provider.id} · {prettyType(
												provider.type,
											)}{provider.status === "inactive"
												? " (inactive)"
												: ""}</option
										>{/each}</select
								><small class:warning={selectedProvider?.status === "inactive"}
									>{selectedProvider?.status === "inactive"
										? "This provider is configured but inactive."
										: selectedProvider
											? `${prettyType(selectedProvider.type)} · ${selectedProvider.status}`
											: "Local and cloud execution stay explicit."}</small
								></label
							><label
								><span>Model</span><select
									bind:value={draft.config.modelId}
									disabled={loading || !draft.config.providerId}
									><option value="">Select model…</option
									>{#each selectableModels as model}<option
											value={model.modelId}>{model.modelId}</option
										>{/each}</select
								><small
									class:warning={unavailableModelProviders.has(
										draft.config.providerId,
									)}
									>{unavailableModelProviders.has(draft.config.providerId)
										? "Live inventory unavailable; showing configured models only."
										: draft.config.providerId && availableModels.length === 0
											? "The provider reported no available models."
											: draft.config.providerId
												? `${availableModels.length} models available from the provider.`
												: "Select a provider to load its models."}</small
								></label
							>
						</div>
					</section>

					<section id="tools" class="form-section">
						<header>
							<span>04</span>
							<div>
								<h2>Tools</h2>
								<p>
									Core tools load immediately; lazy tools are discovered when
									needed.
								</p>
							</div>
							<span class="section-count">{assignedToolCount} assigned</span>
						</header>
						{#if tools.length === 0 && !loading}<div class="tool-empty">
								No tool sets are currently registered. You can still save a
								model-only blueprint.
							</div>{:else}<div class="tool-list">
								<div class="tool-list-head">
									<span>Tool set</span><span>Loading policy</span>
								</div>
								{#each tools as tool}<div class="tool-choice">
										<div class="tool-name">
											<span class="tool-icon">⌘</span>
											<div>
												<strong>{tool}</strong><span
													>{toolMode(tool) === "core"
														? "Available on every turn"
														: toolMode(tool) === "lazy"
															? "Loaded through the tool router"
															: "Not available to this blueprint"}</span
												>
											</div>
										</div>
										<select
											value={toolMode(tool)}
											onchange={(event) =>
												setToolMode(tool, event.currentTarget.value)}
											disabled={loading}
											aria-label={`Loading policy for ${tool}`}
											><option value="off">Not assigned</option><option
												value="core">Core</option
											><option value="lazy">Lazy loaded</option></select
										>
									</div>{/each}
							</div>{/if}
					</section>

					<section id="limits" class="form-section">
						<header>
							<span>05</span>
							<div>
								<h2>Limits</h2>
								<p>Bound how long one response can continue.</p>
							</div>
						</header>
						<label class="number-field"
							><span>Maximum iterations</span><input
								type="number"
								min="1"
								step="1"
								bind:value={draft.config.maxIterations}
								disabled={loading}
							/><small>Stops the run after this many model/tool turns.</small
							></label
						>
					</section>
					<button class="visually-hidden" type="submit">Save blueprint</button>
				</form>

				<aside class="validation-panel">
					<div class="validation-sticky">
						<span class="panel-kicker">Validation</span>
						<h2>Ready check</h2>
						<div class="validation-list">
							<div
								class:valid={Boolean(
									draft.id && /^[a-zA-Z0-9_-]+$/.test(draft.id),
								)}
							>
								<span
									>{draft.id && /^[a-zA-Z0-9_-]+$/.test(draft.id)
										? "✓"
										: "·"}</span
								>
								<div>
									<strong>Identity</strong><small>Valid blueprint ID</small>
								</div>
							</div>
							<div class:valid={Boolean(selectedProvider)}>
								<span>{selectedProvider ? "✓" : "·"}</span>
								<div>
									<strong>Provider</strong><small
										>{selectedProvider?.id ?? "Not selected"}</small
									>
								</div>
							</div>
							<div
								class:valid={Boolean(
									draft.config.modelId &&
										selectableModels.some(
											(model) => model.modelId === draft.config.modelId,
										),
								)}
							>
								<span
									>{draft.config.modelId &&
									selectableModels.some(
										(model) => model.modelId === draft.config.modelId,
									)
										? "✓"
										: "·"}</span
								>
								<div>
									<strong>Model</strong><small
										>{draft.config.modelId || "Not selected"}</small
									>
								</div>
							</div>
							<div class="valid">
								<span>✓</span>
								<div>
									<strong>Tools</strong><small
										>{assignedToolCount
											? `${draft.coreTools.length} core, ${draft.lazyLoadedTools.length} lazy`
											: "Model only"}</small
									>
								</div>
							</div>
						</div>
						{#if formError}<div class="form-error" role="alert">
								<span>!</span>
								<p>{formError}</p>
							</div>{/if}
						<div class="validation-note">
							<strong>Configuration is persisted locally</strong>
							<p>Existing sessions keep the instructions they started with.</p>
						</div>
					</div>
				</aside>
			</div>
		{/if}

		{#if deleteOpen}<div
				class="dialog-backdrop"
				role="presentation"
				onclick={(event) => {
					if (event.target === event.currentTarget) deleteOpen = false;
				}}
			>
				<div
					class="confirm-dialog"
					role="dialog"
					aria-modal="true"
					aria-labelledby="delete-title"
				>
					<div class="dialog-danger-mark">!</div>
					<h2 id="delete-title">Delete “{draft.id}”?</h2>
					<p>
						This removes the blueprint configuration. The API will prevent
						deletion if stored sessions still depend on it.
					</p>
					<div class="dialog-actions">
						<button
							class="button secondary"
							type="button"
							onclick={() => (deleteOpen = false)}>Cancel</button
						><button
							class="button danger"
							type="button"
							onclick={remove}
							disabled={deleting}
							>{deleting ? "Deleting…" : "Delete blueprint"}</button
						>
					</div>
				</div>
			</div>{/if}
	</section>
{/if}

<style>
	/*
	 * Blueprint-specific styles only. The library toolbar, editor grid, form
	 * controls and validation panel are shared with the provider workbench and
	 * live in src/styles/workbench.css and forms.css.
	 */

	/* ------------------------------------------------------- library table */

	.blueprint-table {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 0 0 8px 8px;
		overflow: hidden;
	}
	/* Head and row share a track definition so columns stay aligned. */
	.blueprint-table-head,
	.blueprint-row {
		display: grid;
		grid-template-columns: minmax(250px, 1.5fr) minmax(180px, 1fr) minmax(135px, .7fr) 100px 28px;
		align-items: center;
		column-gap: 20px;
	}
	.blueprint-table-head {
		min-height: 37px;
		padding: 0 16px;
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: .075em;
		text-transform: uppercase;
	}
	.blueprint-row {
		min-height: 77px;
		padding: 11px 16px;
		border-bottom: 1px solid var(--border);
		transition: background 120ms ease;
	}
	.blueprint-row:last-child { border-bottom: 0; }
	a.blueprint-row:hover { background: var(--surface-hover); }
	.blueprint-loading .blueprint-row { min-height: 77px; }

	.blueprint-identity {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 11px;
	}
	.blueprint-identity > div:last-child { min-width: 0; }
	.blueprint-identity strong,
	.blueprint-identity span,
	.provider-model strong,
	.provider-model span,
	.tool-summary strong,
	.tool-summary span,
	.iteration-value strong,
	.iteration-value span { display: block; }
	.blueprint-identity strong,
	.provider-model strong {
		overflow: hidden;
		font-size: 12px;
		font-weight: 580;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.blueprint-identity span {
		max-width: 430px;
		margin-top: 3px;
		overflow: hidden;
		color: var(--muted);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.provider-model span,
	.tool-summary span,
	.iteration-value span {
		margin-top: 3px;
		color: var(--muted);
		font-size: 9px;
	}
	.tool-summary strong,
	.iteration-value strong {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 540;
	}

	.row-arrow {
		color: var(--muted);
		font-size: 15px;
		transition: transform 120ms ease, color 120ms ease;
	}
	a.blueprint-row:hover .row-arrow {
		color: var(--accent);
		transform: translateX(2px);
	}

	/* Four tiles suggesting a blueprint grid; the last is dashed to read as
	   "add one". Decorative — shown on the empty library. */
	.blueprint-glyph {
		display: grid;
		grid-template-columns: 21px 21px;
		grid-template-rows: 21px 21px;
		gap: 4px;
		margin-bottom: 20px;
		padding: 12px;
		background: var(--surface-hover);
		border: 1px solid var(--border);
		border-radius: 11px;
		box-shadow: 0 12px 35px rgb(0 0 0 / 18%);
	}
	.blueprint-glyph span {
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 18%);
		border-radius: 4px;
	}
	.blueprint-glyph span:last-child {
		background: transparent;
		border-style: dashed;
	}

	/* ---------------------------------------------------------- tool picker */

	.tool-list {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.tool-list-head,
	.tool-choice {
		display: grid;
		grid-template-columns: 1fr 145px;
		align-items: center;
	}
	.tool-list-head {
		min-height: 31px;
		padding: 0 11px;
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.tool-choice {
		gap: 18px;
		min-height: 61px;
		padding: 8px 11px;
		border-bottom: 1px solid var(--border);
	}
	.tool-choice:last-child { border-bottom: 0; }
	/* Base control styling comes from .form-section select in forms.css; this
	   only tightens the geometry for the narrow permission column. */
	.tool-choice select {
		height: 31px;
		padding: 0 8px;
		font-size: 9px;
	}

	.tool-name {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 9px;
	}
	.tool-name > div { min-width: 0; }
	.tool-name strong,
	.tool-name span { display: block; }
	.tool-name strong {
		overflow: hidden;
		font-size: 10px;
		font-weight: 570;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool-name div span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	.tool-icon {
		display: grid;
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 15%);
		border-radius: 6px;
		color: var(--healthy);
		font-size: 10px;
	}
	.tool-empty {
		padding: 16px;
		background: var(--surface-sunken);
		border: 1px dashed var(--border-strong);
		border-radius: 6px;
		color: var(--muted);
		font-size: 10px;
		text-align: center;
	}

	/* -------------------------------------------------------- breakpoints */

	@media (max-width: 900px) {
		/* Drop the iteration column. */
		.blueprint-table-head,
		.blueprint-row { grid-template-columns: minmax(220px, 1.5fr) minmax(160px, 1fr) 95px 24px; }
		.blueprint-table-head span:nth-child(4),
		.iteration-value { display: none; }
	}

	@media (max-width: 620px) {
		/* Rows become two stacked lines with the arrow pinned right. */
		.blueprint-table-head { display: none; }
		.blueprint-table { border-radius: 0 0 8px 8px; }
		.blueprint-row {
			grid-template-columns: 1fr 22px;
			gap: 10px;
			min-height: 94px;
		}
		.blueprint-identity { grid-column: 1; }
		.provider-model {
			grid-column: 1;
			margin-left: 46px;
		}
		.tool-summary,
		.iteration-value { display: none; }
		.row-arrow {
			grid-row: 1 / 3;
			grid-column: 2;
		}
		.tool-list-head { display: none; }
		.tool-choice {
			grid-template-columns: 1fr;
			gap: 8px;
			padding: 11px;
		}
	}
</style>
