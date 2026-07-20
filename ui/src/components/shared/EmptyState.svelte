<script lang="ts">
	/*
	 * The empty state for a library view, in its two sizes.
	 *
	 * The full size introduces a resource that has never been created and gets
	 * a decorative mark; the `compact` size reports that a search matched
	 * nothing and is deliberately smaller, because the surrounding controls are
	 * still on screen. Styling comes from `.library-empty` / `.compact-empty`
	 * in primitives.css.
	 */
	import type { Snippet } from "svelte";

	type Props = {
		/** The call to action: a link for first-run, a reset for a stale search. */
		action?: Snippet;
		compact?: boolean;
		description: string;
		/** Decorative glyph above the heading; omitted in the compact size. */
		mark?: Snippet;
		/**
		 * Set when the state stands alone rather than continuing the toolbar
		 * above it, which changes how it is rounded off.
		 */
		standalone?: boolean;
		title: string;
		/** Optional line above the heading, naming the state rather than the fix. */
		kicker?: string;
	};

	let { action, compact = false, description, kicker, mark, standalone = false, title }: Props = $props();
</script>

<div class="library-empty" class:compact-empty={compact} class:standalone>
	{#if mark}{@render mark()}{/if}
	{#if kicker}<span class="panel-kicker">{kicker}</span>{/if}
	<h2>{title}</h2>
	<p>{description}</p>
	{#if action}{@render action()}{/if}
</div>
