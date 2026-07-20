<script lang="ts">
	import Markdown from "../shared/Markdown.svelte";

	type Props = {
		source: string;
		/** A live block is still receiving tokens and folds itself once prose starts. */
		live?: boolean;
		open?: boolean;
		hint: string;
	};

	let { source, live = false, open = false, hint }: Props = $props();
</script>

<details class="reasoning-block" class:live {open}>
	<summary><span>Reasoning</span><small>{hint}</small></summary>
	<div><Markdown {source} /></div>
</details>

<style>
	/* Reasoning is secondary to the answer: dimmed, indented behind a rule, and
	   collapsed by default once the assistant starts replying. */
	.reasoning-block {
		margin: 0 0 14px;
		border-left: 1px solid rgb(154 167 158 / 24%);
		color: var(--muted);
		opacity: .68;
	}
	.reasoning-block summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 4px 9px;
		cursor: pointer;
		font-size: 8px;
		list-style: none;
		text-transform: uppercase;
		letter-spacing: .08em;
	}
	.reasoning-block summary::-webkit-details-marker { display: none; }
	.reasoning-block summary::before {
		content: '›';
		font-family: var(--font-mono);
		transition: transform 120ms ease;
	}
	.reasoning-block[open] summary::before { transform: rotate(90deg); }
	.reasoning-block summary span { margin-right: auto; }
	.reasoning-block summary small {
		font-size: 7px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
	}
	.reasoning-block > div {
		max-height: 220px;
		overflow: auto;
		padding: 3px 9px 8px 24px;
		font-size: 10px;
		font-style: italic;
		line-height: 1.55;
	}
	/* Collapsed and still streaming: tighten the gap to the prose below. */
	.reasoning-block.live:not([open]) { margin-bottom: 8px; }
</style>
