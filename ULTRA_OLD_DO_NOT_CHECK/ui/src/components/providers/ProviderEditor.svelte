<script lang="ts">
	/*
	 * The create and edit form for one provider.
	 *
	 * Both routes share this component: they differ only in whether the id is
	 * editable, whether Delete is offered, and the wording. The three numbered
	 * sections and the checklist beside them own their own markup.
	 */
	import ConfirmDialog from "../shared/ConfirmDialog.svelte";
	import ErrorState from "../shared/ErrorState.svelte";
	import { configuredModelCount, deleteProvider, draft, saveProvider, status } from "../../stores/providers";
	import ConnectionSection from "./ConnectionSection.svelte";
	import CredentialsSection from "./CredentialsSection.svelte";
	import ModelsSection from "./ModelsSection.svelte";
	import ValidationPanel from "./ValidationPanel.svelte";

	type Props = { view: "new" | "edit" };

	let { view }: Props = $props();

	/** Dialog visibility is view state, so it stays out of the store. */
	let deleteOpen = $state(false);
</script>

<section class="workbench-editor provider-editor">
	<header class="editor-titlebar">
		<div>
			<a class="back-link" href="/providers">← Providers</a>
			<div class="editor-title">
				<span class="editor-mark provider-editor-mark">{view === "new" ? "+" : $draft.id.slice(0, 2).toUpperCase()}</span>
				<div>
					<span class="eyebrow">{view === "new" ? "New connection" : "Provider configuration"}</span>
					<h1>{view === "new" ? "Add provider" : $status.loading ? "Loading provider…" : $draft.id}</h1>
				</div>
			</div>
		</div>
		<div class="editor-actions">
			{#if view === "edit"}
				<button class="button danger-outline" type="button" onclick={() => (deleteOpen = true)} disabled={$status.loading}>Delete</button>
			{/if}
			<a class="button secondary" href="/providers">Cancel</a>
			<button class="button primary" type="button" onclick={() => saveProvider(view)} disabled={$status.loading || $status.saving}>
				{$status.saving ? "Saving…" : view === "new" ? "Add provider" : "Save changes"}
			</button>
		</div>
	</header>

	{#if $status.error && !$status.loading}
		<ErrorState title="Editor unavailable" message={$status.error}>
			{#snippet action()}<a class="button secondary" href="/providers">Back to providers</a>{/snippet}
		</ErrorState>
	{:else}
		<div class="editor-grid" class:editor-loading={$status.loading}>
			<nav class="editor-sections" aria-label="Provider sections">
				<span class="editor-nav-label">Configuration</span>
				<a class="active" href="#connection">Connection</a>
				<a href="#credentials">Credentials</a>
				<a href="#models">Models <span>{$configuredModelCount}</span></a>
			</nav>

			<form class="editor-form" onsubmit={(event) => { event.preventDefault(); saveProvider(view); }}>
				<ConnectionSection {view} />
				<CredentialsSection />
				<ModelsSection />
				<!-- Lets Enter submit the form; the visible action is in the titlebar. -->
				<button class="visually-hidden" type="submit">Save provider</button>
			</form>

			<ValidationPanel />
		</div>
	{/if}

	{#if deleteOpen}
		<ConfirmDialog
			title={`Delete “${$draft.id}”?`}
			confirmLabel="Delete provider"
			busyLabel="Deleting…"
			busy={$status.deleting}
			onconfirm={deleteProvider}
			oncancel={() => (deleteOpen = false)}
		>
			{#snippet description()}
				This removes the provider configuration and stored credential. Deletion is blocked
				while a blueprint still references it.
			{/snippet}
		</ConfirmDialog>
	{/if}
</section>

<style>
	/* The editor mark reuses the library card's blue, rather than the amber
	   the shared .editor-mark carries. */
	.provider-editor-mark {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 18%);
		color: #91b5d6;
	}
</style>
