<script lang="ts">
	import { renderMarkdown } from "../../utils/markdown";

	export let source = "";

	$: rendered = renderMarkdown(source);
</script>

<div class="markdown-body">{@html rendered}</div>

<style>
	/*
	 * The body is injected with {@html}, so the compiler never sees these
	 * elements and would strip plain descendant selectors as unused. Every
	 * descendant is therefore wrapped in :global(), kept inside the scoped
	 * .markdown-body root so the reach stays bounded to this component.
	 */

	.markdown-body > :global(:first-child) { margin-top: 0; }
	.markdown-body > :global(:last-child) { margin-bottom: 0; }

	.markdown-body :global(p) { margin: 0 0 10px; }

	.markdown-body :global(h1),
	.markdown-body :global(h2),
	.markdown-body :global(h3),
	.markdown-body :global(h4) {
		margin: 18px 0 8px;
		color: var(--text);
		font-weight: 620;
		line-height: 1.3;
		letter-spacing: -.015em;
	}
	.markdown-body :global(h1) { font-size: 18px; }
	.markdown-body :global(h2) {
		padding-bottom: 5px;
		border-bottom: 1px solid var(--border);
		font-size: 16px;
	}
	.markdown-body :global(h3) { font-size: 14px; }
	.markdown-body :global(h4) { font-size: 12px; }

	.markdown-body :global(ul),
	.markdown-body :global(ol) {
		margin: 8px 0 12px;
		padding-left: 21px;
	}
	.markdown-body :global(li) { padding-left: 2px; }
	.markdown-body :global(li + li) { margin-top: 4px; }
	.markdown-body :global(li > ul),
	.markdown-body :global(li > ol) { margin: 4px 0; }

	.markdown-body :global(strong) {
		color: var(--text);
		font-weight: 650;
	}
	.markdown-body :global(em) { color: #c5ccc7; }
	.markdown-body :global(a) {
		color: #dfbb76;
		text-decoration: underline;
		text-decoration-color: rgb(208 164 92 / 38%);
		text-underline-offset: 2px;
	}
	.markdown-body :global(a:hover) {
		color: #ebcb8d;
		text-decoration-color: currentColor;
	}

	.markdown-body :global(blockquote) {
		margin: 12px 0;
		padding: 4px 0 4px 12px;
		border-left: 2px solid #5b4c32;
		color: var(--secondary);
	}
	.markdown-body :global(blockquote p) { margin-bottom: 6px; }

	.markdown-body :global(code) {
		padding: 2px 4px;
		background: var(--code-bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: #b9d1c1;
		font-family: var(--font-mono-explicit);
		font-size: .88em;
	}
	.markdown-body :global(pre) {
		max-width: 100%;
		margin: 12px 0;
		padding: 11px 12px;
		overflow: auto;
		background: #090c0a;
		border: 1px solid var(--border);
		border-radius: 6px;
		scrollbar-width: thin;
		scrollbar-color: var(--surface-3) transparent;
	}
	/* min-width: max-content keeps long lines scrolling rather than wrapping. */
	.markdown-body :global(pre code) {
		display: block;
		min-width: max-content;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
		color: #c4d0c8;
		font-size: 10px;
		line-height: 1.55;
		white-space: pre;
	}

	.markdown-body :global(table) {
		width: 100%;
		margin: 12px 0;
		border-spacing: 0;
		border-collapse: separate;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 10px;
	}
	.markdown-body :global(th),
	.markdown-body :global(td) {
		padding: 7px 9px;
		border-right: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	.markdown-body :global(th) {
		background: var(--surface-sunken);
		color: var(--secondary);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .045em;
		text-transform: uppercase;
	}
	.markdown-body :global(tr:last-child td) { border-bottom: 0; }
	.markdown-body :global(th:last-child),
	.markdown-body :global(td:last-child) { border-right: 0; }

	.markdown-body :global(hr) {
		height: 1px;
		margin: 18px 0;
		background: var(--border);
		border: 0;
	}
</style>
