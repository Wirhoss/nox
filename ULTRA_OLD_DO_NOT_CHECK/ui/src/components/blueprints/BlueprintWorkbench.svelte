<script lang="ts">
	/*
	 * Entry point for the three blueprint routes.
	 *
	 * Astro renders one island per page and passes the route in as `view`, so
	 * this component's only job is to load the matching data and hand off to
	 * the library or the editor.
	 */
	import { onMount } from "svelte";

	import { loadWorkbench } from "../../stores/blueprints";
	import BlueprintEditor from "./BlueprintEditor.svelte";
	import BlueprintLibrary from "./BlueprintLibrary.svelte";

	type Props = { view?: "library" | "new" | "edit" };

	let { view = "library" }: Props = $props();

	onMount(() => loadWorkbench(view));
</script>

{#if view === "library"}
	<BlueprintLibrary />
{:else}
	<BlueprintEditor {view} />
{/if}
