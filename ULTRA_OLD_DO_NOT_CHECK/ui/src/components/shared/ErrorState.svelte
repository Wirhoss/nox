<script lang="ts">
	/*
	 * The full-panel failure state, shown when a workbench has no data to render.
	 *
	 * Every workbench previously inlined this markup. The styling lives on the
	 * global `.error-state` class in primitives.css, so this component carries
	 * no styles of its own — it exists to keep the structure and the wording
	 * pattern ("<resource> unavailable" + cause + a way out) consistent.
	 */
	import type { Snippet } from "svelte";

	type Props = {
		/** Replaces the retry button when recovery means navigating away. */
		action?: Snippet;
		message: string;
		onretry?: () => void;
		title: string;
	};

	let { action, message, onretry, title }: Props = $props();
</script>

<div class="error-state">
	<div class="error-symbol">!</div>
	<strong>{title}</strong>
	<p>{message}</p>
	{#if action}
		{@render action()}
	{:else if onretry}
		<button class="button secondary" type="button" onclick={onretry}>Try again</button>
	{/if}
</div>
