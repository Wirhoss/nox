<script lang="ts">
	import { formatMessageTime } from "../../utils/format";
	import Avatar from "../shared/Avatar.svelte";

	import type { Snippet } from "svelte";

	type Props = {
		role: "user" | "assistant";
		blueprintId: string;
		/** Adds the pulsing dot shown while tokens are still arriving. */
		streaming?: boolean;
		time: Date | null;
		children: Snippet;
	};

	let { role, blueprintId, streaming = false, time, children }: Props = $props();

	const isAssistant = $derived(role === "assistant");
</script>

<article class="chat-message" class:assistant={isAssistant} class:streaming>
	<div class="message-author">
		<Avatar
			kind={isAssistant ? "blueprint" : "user"}
			seed={isAssistant ? `blueprint:${blueprintId}` : "nox-local-user"}
			size={28}
			decorative
		/>
		<strong>{isAssistant ? blueprintId : "You"}</strong>
		{#if streaming}<i></i>{/if}
	</div>
	<div class="message-body">
		{@render children()}
		<footer class="message-footer" class:live={streaming}>{formatMessageTime(time)}</footer>
	</div>
</article>

<style>
	.chat-message {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		gap: 11px;
		margin-bottom: 28px;
	}
	/* display: contents lets the avatar and name drop into the parent grid.
	   The avatar itself is an <img> rendered by Avatar.svelte, which styles
	   itself — this component only positions it. */
	.message-author { display: contents; }
	.message-author strong {
		align-self: center;
		font-size: 10px;
		font-weight: 590;
	}
	.message-body {
		grid-column: 2;
		min-width: 0;
		margin-top: -4px;
		color: #d8ded9;
		font-size: 12px;
		line-height: 1.65;
		overflow-wrap: anywhere;
	}
	/* Timestamp closing the turn, right-aligned under a hairline. */
	.message-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		margin-top: 9px;
		padding-top: 6px;
		border-top: 1px solid rgb(154 167 158 / 10%);
		color: var(--muted);
		font-family: var(--font-mono-explicit);
		font-size: 7px;
		font-style: normal;
		letter-spacing: .015em;
		line-height: 1.2;
	}
	/* Still streaming: the time is provisional until the run settles. */
	.message-footer.live { opacity: .7; }
	/* User messages get a bubble; assistant messages sit flush. */
	.chat-message:not(.assistant) .message-body {
		padding: 10px 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 2px 8px 8px 8px;
	}
	/* :global because the body is filled by a snippet from another component,
	   and because Markdown emits {@html} output that carries no scope class. */
	.message-body :global(img) {
		display: block;
		max-width: min(100%, 520px);
		max-height: 380px;
		margin-top: 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		object-fit: contain;
	}

	.chat-message.streaming { position: relative; }
	.chat-message.streaming .message-author i {
		display: inline-block;
		width: 5px;
		height: 5px;
		margin-left: 5px;
		background: var(--healthy);
		border-radius: 50%;
		animation: status-pulse 1.2s ease infinite;
	}
</style>
