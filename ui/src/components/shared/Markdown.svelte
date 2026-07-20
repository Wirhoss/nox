<script lang="ts">
	import { renderMarkdown } from "../../utils/markdown";

	export let source = "";

	$: rendered = renderMarkdown(source);
</script>

<div class="markdown-body">{@html rendered}</div>
