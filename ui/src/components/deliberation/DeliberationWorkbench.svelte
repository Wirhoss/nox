<script lang="ts">
	import { onMount } from "svelte";

	import { blueprints } from "../../stores/catalog";
	import { draft, items, load, query, save, setDraftField, status } from "../../stores/deliberation";
	import ActivityLibrary from "../operate/ActivityLibrary.svelte";
	import DeliberationCreator from "./DeliberationCreator.svelte";
	import DeliberationDetail from "./DeliberationDetail.svelte";

	type Props = { view?: "library" | "new" | "detail" };
	let { view = "library" }: Props = $props();

	const libraryCopy = {
		action: "New deliberation",
		description: "Run independent proposals, structured critique, and a moderated decision synthesis.",
		emptyDescription: "Frame a decision, select participant blueprints, and let a moderator preserve both consensus and dissent.",
		emptyKicker: "No decisions yet",
		emptyTitle: "Start your first deliberation",
		search: "Search decisions and questions…",
		title: "Deliberation",
	};

	const cards = $derived($items.map((item) => ({
		id: item.deliberationId,
		outcome: item.question,
		stage: item.status === "active" ? `Round ${item.currentRound} of ${item.rounds} max` : item.status === "completed" ? item.consensusReached ? `Consensus · round ${item.currentRound}` : "Maximum rounds reached" : item.participantBlueprintIds.length >= 2 && item.moderatorBlueprintId ? "Ready to run" : "Needs setup",
		status: item.status,
		title: item.title,
		updatedAt: item.updatedAt,
	})));

	onMount(() => {
		if (view !== "detail") void load(view === "new");
	});
</script>

{#if view === "library"}
	<ActivityLibrary copy={libraryCopy} error={$status.error} itemBasePath="/deliberation/detail" items={cards} loading={$status.loading} newPath="/deliberation/new" onretry={() => { void load(); }} bind:query={$query} tone="deliberation" />
{:else if view === "new"}
	<DeliberationCreator blueprints={$blueprints} draft={$draft} error={$status.error} formError={$status.formError} loading={$status.loading} onsave={save} onfield={setDraftField} saving={$status.action === "saving"} />
{:else}
	<DeliberationDetail />
{/if}
