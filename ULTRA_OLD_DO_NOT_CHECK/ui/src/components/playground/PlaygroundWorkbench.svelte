<script lang="ts">
	/*
	 * Playground shell.
	 *
	 * This component owns layout and first-run states only. Session state and
	 * the event stream live in `stores/playground.ts`; the three columns read
	 * from it directly rather than receiving props from here.
	 */
	import { onDestroy, onMount } from "svelte";

	import { blueprints, dismissError, loadPlayground, status, teardownPlayground } from "../../stores/playground";
	import ClearSessionDialog from "./ClearSessionDialog.svelte";
	import ConversationPanel from "./ConversationPanel.svelte";
	import DeleteSessionDialog from "./DeleteSessionDialog.svelte";
	import PlaygroundToolbar from "./PlaygroundToolbar.svelte";
	import RunInspector from "./RunInspector.svelte";
	import SessionPanel from "./SessionPanel.svelte";

	let clearOpen = $state(false);
	let deleteOpen = $state(false);

	onMount(() => {
		void loadPlayground();
	});
	onDestroy(teardownPlayground);
</script>

<section class="playground-page">
	<PlaygroundToolbar onclear={() => (clearOpen = true)} ondelete={() => (deleteOpen = true)} />

	{#if $status.error}
		<div class="playground-notice" role="alert">
			<span>!</span>
			<p>{$status.error}</p>
			<button type="button" aria-label="Dismiss error" onclick={dismissError}>×</button>
		</div>
	{/if}

	{#if $status.loading}
		<div class="playground-loading">
			<span class="table-skeleton long"></span>
			<span class="table-skeleton"></span>
			<span class="table-skeleton short"></span>
		</div>
	{:else if $blueprints.length === 0}
		<div class="playground-setup-empty">
			<div class="playground-empty-mark"><span>›_</span></div>
			<span class="panel-kicker">A runnable definition is required</span>
			<h2>Create a blueprint first</h2>
			<p>The Playground starts isolated sessions from a saved blueprint and its configured provider.</p>
			<a class="button primary" href="/blueprints/new">Create blueprint</a>
		</div>
	{:else}
		<div class="playground-shell">
			<SessionPanel />
			<ConversationPanel />
			<RunInspector />
		</div>
	{/if}

	{#if clearOpen}
		<ClearSessionDialog onclose={() => (clearOpen = false)} />
	{/if}
	{#if deleteOpen}
		<DeleteSessionDialog onclose={() => (deleteOpen = false)} />
	{/if}
</section>

<style>
	/*
	 * The playground is a fixed-height, three-column app view rather than a
	 * scrolling document: session list | conversation | run inspector.
	 *
	 * It reads --playground-gutter, which AppLayout sets on .app-content when
	 * the playground-content modifier is applied.
	 */

	.playground-page {
		display: flex;
		/* dvh repeats the vh line so mobile browsers with a collapsing URL bar
		   get the dynamic value while older engines keep the static one. */
		height: calc(100vh - var(--topbar-height) - var(--playground-gutter) - var(--playground-gutter));
		height: calc(100dvh - var(--topbar-height) - var(--playground-gutter) - var(--playground-gutter));
		min-height: 0;
		overflow: hidden;
		flex-direction: column;
		background: rgb(12 15 13 / 72%);
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.playground-notice {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr) 24px;
		align-items: center;
		gap: 8px;
		margin: 10px 14px 0;
		padding: 8px 10px;
		background: var(--danger-soft);
		border: 1px solid rgb(216 120 114 / 18%);
		border-radius: 6px;
		color: #dd928d;
	}
	.playground-notice > span {
		display: grid;
		width: 18px;
		height: 18px;
		place-items: center;
		border: 1px solid rgb(216 120 114 / 30%);
		border-radius: 50%;
		font-size: 9px;
		font-weight: 700;
	}
	.playground-notice p {
		margin: 0;
		font-size: 10px;
	}
	.playground-notice button {
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		border: 0;
		color: var(--muted);
		cursor: pointer;
		font-size: 16px;
	}

	/* ------------------------------------------------------ first-run states */

	.playground-loading {
		display: flex;
		min-height: 0;
		flex: 1;
		justify-content: center;
		flex-direction: column;
		gap: 24px;
		padding: 15%;
	}
	.playground-setup-empty {
		display: flex;
		min-height: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 30px;
		text-align: center;
	}
	.playground-setup-empty h2 {
		margin: 5px 0 0;
		font-size: 20px;
		font-weight: 570;
	}
	.playground-setup-empty p {
		max-width: 390px;
		margin: 7px 0 18px;
		color: var(--muted);
		font-size: 11px;
	}
	.playground-empty-mark {
		display: grid;
		width: 52px;
		height: 52px;
		place-items: center;
		margin-bottom: 20px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 12px 35px rgb(0 0 0 / 18%);
		color: var(--accent);
		font-family: var(--font-mono);
		font-size: 15px;
	}

	/* ---------------------------------------------------------- three-column */

	.playground-shell {
		display: grid;
		min-height: 0;
		flex: 1 1 auto;
		grid-template-columns: 218px minmax(430px, 1fr) 264px;
		overflow: hidden;
		background: rgb(12 15 13 / 72%);
	}

	/* Each column carries its own responsive behaviour; the shell only decides
	   how many tracks there are. */
	@media (max-width: 1120px) {
		.playground-shell {
			grid-template-columns: 190px minmax(410px, 1fr);
			grid-template-rows: minmax(0, 1fr) auto;
		}
	}

	@media (max-width: 900px) {
		.playground-shell {
			grid-template-columns: 1fr;
			grid-template-rows: none;
			overflow-y: auto;
		}
	}
</style>
