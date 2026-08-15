<script lang="ts">
	/*
	 * Entry point for the three provider routes.
	 *
	 * Astro renders one island per page and passes the route in as `view`, so
	 * this component's only job is to load the matching data and hand off to
	 * the library or the editor.
	 */
	import { onMount } from "svelte";

	import { loadWorkbench } from "../../stores/providers";
	import ProviderEditor from "./ProviderEditor.svelte";
	import ProviderLibrary from "./ProviderLibrary.svelte";

	type Props = { view?: "library" | "new" | "edit" };

	let { view = "library" }: Props = $props();

	onMount(() => loadWorkbench(view));
</script>

{#if view === "library"}
	<ProviderLibrary />
{:else}
	<ProviderEditor {view} />
{/if}
