<script lang="ts">
	/*
	 * The create and edit form for one blueprint.
	 *
	 * Both routes share this component: they differ in whether the id is
	 * editable, whether Delete and the Playground shortcut are offered, and the
	 * wording. The five numbered sections and the checklist own their markup.
	 */
	import Avatar from "../shared/Avatar.svelte";
	import ConfirmDialog from "../shared/ConfirmDialog.svelte";
	import ErrorState from "../shared/ErrorState.svelte";
	import { assignedToolCount, deleteBlueprint, draft, saveBlueprint, status } from "../../stores/blueprints";
	import GeneralSection from "./GeneralSection.svelte";
	import InstructionsSection from "./InstructionsSection.svelte";
	import LimitsSection from "./LimitsSection.svelte";
	import RuntimeSection from "./RuntimeSection.svelte";
	import ToolsSection from "./ToolsSection.svelte";
	import ValidationPanel from "./ValidationPanel.svelte";

	type Props = { view: "new" | "edit" };

	let { view }: Props = $props();

	/** Dialog visibility is view state, so it stays out of the store. */
	let deleteOpen = $state(false);
</script>

<section class="workbench-editor">
	<header class="editor-titlebar">
		<div>
			<a class="back-link" href="/blueprints">← Blueprints</a>
			<div class="editor-title">
				{#if view === "new"}
					<span class="editor-mark">+</span>
				{:else}
					<Avatar kind="blueprint" seed={`blueprint:${$draft.id}`} label={$draft.id} size={39} />
				{/if}
				<div>
					<span class="eyebrow">{view === "new" ? "New definition" : "Blueprint editor"}</span>
					<h1>{view === "new" ? "Create blueprint" : $status.loading ? "Loading blueprint…" : $draft.id}</h1>
				</div>
			</div>
		</div>
		<div class="editor-actions">
			{#if view === "edit"}
				<button class="button danger-outline" type="button" onclick={() => (deleteOpen = true)} disabled={$status.loading}>Delete</button>
				<a class="button secondary playground-launch" href={`/playground?blueprint=${encodeURIComponent($draft.id)}`}>Test in Playground</a>
			{/if}
			<a class="button secondary" href="/blueprints">Cancel</a>
			<button class="button primary" type="button" onclick={() => saveBlueprint(view)} disabled={$status.loading || $status.saving}>
				{$status.saving ? "Saving…" : view === "new" ? "Create blueprint" : "Save changes"}
			</button>
		</div>
	</header>

	{#if $status.error && !$status.loading}
		<ErrorState title="Editor unavailable" message={$status.error}>
			{#snippet action()}
				<a class="button secondary" href="/blueprints">Back to library</a>
			{/snippet}
		</ErrorState>
	{:else}
		<div class="editor-grid" class:editor-loading={$status.loading}>
			<nav class="editor-sections" aria-label="Blueprint sections">
				<span class="editor-nav-label">Configuration</span>
				<a class="active" href="#general">General</a>
				<a href="#instructions">Instructions</a>
				<a href="#runtime">Provider &amp; model</a>
				<a href="#tools">Tools <span>{$assignedToolCount}</span></a>
				<a href="#limits">Limits</a>
			</nav>

			<form class="editor-form" onsubmit={(event) => { event.preventDefault(); saveBlueprint(view); }}>
				<GeneralSection {view} />
				<InstructionsSection />
				<RuntimeSection />
				<ToolsSection />
				<LimitsSection />
				<!-- Lets Enter submit the form; the visible action is in the titlebar. -->
				<button class="visually-hidden" type="submit">Save blueprint</button>
			</form>

			<ValidationPanel />
		</div>
	{/if}

	{#if deleteOpen}
		<ConfirmDialog
			title={`Delete “${$draft.id}”?`}
			confirmLabel="Delete blueprint"
			busyLabel="Deleting…"
			busy={$status.deleting}
			onconfirm={deleteBlueprint}
			oncancel={() => (deleteOpen = false)}
		>
			{#snippet description()}
				This removes the blueprint configuration. The API will prevent deletion if stored
				sessions still depend on it.
			{/snippet}
		</ConfirmDialog>
	{/if}
</section>
