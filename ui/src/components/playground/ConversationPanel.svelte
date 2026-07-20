<script lang="ts">
	import { tick } from "svelte";

	import {
		abortRun,
		createSession,
		currentSession,
		messages,
		permissions,
		run,
		selectedBlueprint,
		status,
		stream,
	} from "../../stores/playground";
	import { shortId } from "../../utils/format";
	import MessageComposer from "./MessageComposer.svelte";
	import MessageStack from "./MessageStack.svelte";
	import PermissionDock from "./PermissionDock.svelte";

	let scrollElement = $state<HTMLDivElement | null>(null);

	const conversationState = $derived(
		$run.active
			? ($permissions.length > 0 ? "Waiting for permission" : "Responding")
			: $currentSession ? "Ready" : "No session",
	);

	// Follow the transcript as it grows. Reading these three values registers
	// the dependency; the tick lets the new content lay out before scrolling.
	$effect(() => {
		void $messages.length;
		void $stream.text;
		void $stream.reasoning;
		void tick().then(() => {
			scrollElement?.scrollTo({ behavior: "smooth", top: scrollElement.scrollHeight });
		});
	});
</script>

<main class="playground-conversation">
	<header class="conversation-head">
		<div>
			<span class="conversation-state" class:live={$run.active}><i></i>{conversationState}</span>
			{#if $currentSession}<code>{shortId($currentSession.sessionId)}</code>{/if}
		</div>
		{#if $run.active}
			<button class="stop-run" type="button" onclick={abortRun} disabled={$status.aborting}>
				<span></span>{$status.aborting ? "Stopping…" : "Stop run"}
			</button>
		{/if}
	</header>

	<div class="conversation-scroll" bind:this={scrollElement}>
		{#if !$currentSession}
			<div class="conversation-empty">
				<div class="conversation-empty-orbit"><span></span></div>
				<h2>Start a scratch session</h2>
				<p>Test <strong>{$selectedBlueprint?.id}</strong> in an isolated, locally stored conversation.</p>
				<button class="button primary" type="button" onclick={createSession} disabled={$status.creating}>
					{$status.creating ? "Starting…" : "Start session"}
				</button>
			</div>
		{:else if $messages.length === 0 && !$stream.text}
			<div class="conversation-empty">
				<div class="conversation-empty-orbit ready"><span></span></div>
				<span class="panel-kicker">Session ready</span>
				<h2>What should {$selectedBlueprint?.id} work on?</h2>
				<p>Messages and tool activity will appear here as they happen.</p>
			</div>
		{:else}
			<MessageStack />
		{/if}
	</div>

	{#if $permissions.length > 0}
		<PermissionDock />
	{/if}

	<MessageComposer />
</main>

<style>
	/* Rows: header | scrolling transcript | permission dock | composer. */
	.playground-conversation {
		display: grid;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-height: 100%;
		overflow: hidden;
		grid-template-rows: 53px minmax(0, 1fr) auto auto;
		background: rgb(12 15 13 / 78%);
	}
	.conversation-head {
		display: flex;
		height: 53px;
		align-items: center;
		justify-content: space-between;
		padding: 0 18px;
		border-bottom: 1px solid var(--border);
	}
	.conversation-head > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 10px;
	}
	.conversation-head code {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}
	.conversation-state {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 9px;
		font-weight: 570;
	}
	.conversation-state i {
		display: block;
		width: 6px;
		height: 6px;
		background: var(--muted);
		border-radius: 50%;
	}
	.conversation-state.live { color: #8fc2a1; }
	.conversation-state.live i {
		background: var(--healthy);
		box-shadow: 0 0 0 3px rgb(105 180 134 / 10%);
		animation: status-pulse 1.5s ease infinite;
	}
	.stop-run {
		display: flex;
		height: 29px;
		align-items: center;
		gap: 6px;
		padding: 0 9px;
		background: var(--danger-soft);
		border: 1px solid rgb(216 120 114 / 18%);
		border-radius: 5px;
		color: var(--danger-text);
		cursor: pointer;
		font-size: 9px;
	}
	.stop-run span {
		display: block;
		width: 7px;
		height: 7px;
		background: currentColor;
		border-radius: 1px;
	}

	/* overscroll-behavior stops the page bouncing when the transcript ends;
	   scrollbar-gutter keeps the column from shifting as content grows. */
	.conversation-scroll {
		height: 100%;
		min-height: 0;
		max-height: 100%;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--surface-3) transparent;
	}
	.conversation-scroll::-webkit-scrollbar { width: 8px; }
	.conversation-scroll::-webkit-scrollbar-track { background: transparent; }
	.conversation-scroll::-webkit-scrollbar-thumb {
		background: var(--surface-3);
		border: 2px solid transparent;
		border-radius: 8px;
		background-clip: padding-box;
	}

	.conversation-empty {
		display: flex;
		min-height: 100%;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 35px;
		text-align: center;
	}
	.conversation-empty h2 {
		margin: 7px 0 0;
		font-size: 17px;
		font-weight: 570;
		letter-spacing: -.02em;
	}
	.conversation-empty p {
		max-width: 340px;
		margin: 6px 0 17px;
		color: var(--muted);
		font-size: 10px;
	}
	.conversation-empty p strong {
		color: var(--secondary);
		font-weight: 570;
	}
	/* Concentric rings with a dot at the centre; turns green once ready. */
	.conversation-empty-orbit {
		position: relative;
		display: grid;
		width: 48px;
		height: 48px;
		place-items: center;
		margin-bottom: 13px;
		border: 1px solid var(--border);
		border-radius: 50%;
	}
	.conversation-empty-orbit::before,
	.conversation-empty-orbit::after {
		position: absolute;
		border: 1px solid var(--border);
		border-radius: 50%;
		content: '';
	}
	.conversation-empty-orbit::before { inset: 7px; }
	.conversation-empty-orbit::after {
		inset: 15px;
		background: var(--surface-2);
	}
	.conversation-empty-orbit span {
		z-index: 1;
		width: 5px;
		height: 5px;
		background: var(--muted);
		border-radius: 50%;
	}
	.conversation-empty-orbit.ready span {
		background: var(--healthy);
		box-shadow: 0 0 0 4px rgb(105 180 134 / 9%);
	}

	/* Once the shell stops being a fixed-height app view, the conversation
	   needs a floor so it does not collapse to its content. */
	@media (max-width: 900px) {
		.playground-conversation { min-height: 620px; }
	}

	@media (max-width: 620px) {
		.playground-conversation { min-height: 590px; }
		.conversation-head { padding: 0 12px; }
	}
</style>
