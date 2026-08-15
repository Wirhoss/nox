<script lang="ts">
	import { imageContent, imageSource, textContent } from "../../utils/messages";
	import Markdown from "../shared/Markdown.svelte";

	import type { TextMessage } from "../../utils/types";

	type Props = { message: TextMessage };

	let { message }: Props = $props();

	const text = $derived(textContent(message));
	const images = $derived(imageContent(message));
</script>

<Markdown source={text} />
{#each images as image}
	<!-- Sized by ChatMessage's `.message-body :global(img)`, which also covers
	     the images Markdown emits as raw HTML. -->
	<img src={imageSource(image)} alt="Message attachment" />
{/each}
