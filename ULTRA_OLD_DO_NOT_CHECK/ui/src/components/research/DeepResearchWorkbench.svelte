<script lang="ts">
	import { onMount } from "svelte";

	import { draft, items, load, query, save, setDraftField, status } from "../../stores/deepResearch";
	import ActivityCreator from "../operate/ActivityCreator.svelte";
	import ActivityLibrary from "../operate/ActivityLibrary.svelte";

	type Props = { view?: "library" | "new" };
	let { view = "library" }: Props = $props();

	const libraryCopy = {
		action: "New research",
		description: "Plan investigations, verify evidence, and synthesize durable research reports.",
		emptyDescription: "Define a research question and outcome. Team composition, depth, and evidence policy come next.",
		emptyKicker: "No research activities yet",
		emptyTitle: "Start your first deep research",
		search: "Search research goals and titles…",
		title: "Deep Research",
	};
	const creatorCopy = {
		backLabel: "Deep Research",
		button: "Create research draft",
		description: "Define the research outcome now; team composition, depth, and evidence policy come next.",
		label: "Deep Research",
		nextCoordination: "Depth & budget",
		nextCoordinationHelp: "Choose investigation depth, source targets, validation, and limits.",
		nextTeam: "Research team & roles",
		nextTeamHelp: "Assign coordination, investigation, evidence checking, and synthesis.",
		outcomeHelp: "Be explicit about scope, constraints, and what the final report should contain.",
		outcomeLabel: "Research objective",
		outcomePlaceholder: "Compare the strongest local retrieval approaches and recommend one for our constraints…",
		pattern: "Parallel investigation, evidence verification, and report synthesis.",
		titlePlaceholder: "Local RAG options",
	};

	const cards = $derived($items.map((item) => ({
		id: item.researchId,
		outcome: item.objective,
		status: item.status,
		title: item.title,
		updatedAt: item.updatedAt,
	})));

	onMount(() => load(view === "new"));
</script>

{#if view === "library"}
	<ActivityLibrary copy={libraryCopy} error={$status.error} items={cards} loading={$status.loading} newPath="/deep-research/new" onretry={() => { void load(); }} bind:query={$query} tone="research" />
{:else}
	<ActivityCreator backPath="/deep-research" copy={creatorCopy} error={$status.error} formError={$status.formError} loading={$status.loading} onoutcome={(value) => setDraftField("objective", value)} onsave={save} ontitle={(value) => setDraftField("title", value)} outcome={$draft.objective} saving={$status.saving} title={$draft.title} tone="research" />
{/if}
