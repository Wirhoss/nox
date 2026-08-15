<script lang="ts">
	/*
	 * Identity of the blueprint.
	 *
	 * The id is fixed once created: sessions and runs reference it, so a rename
	 * would orphan the history rather than move it.
	 */
	import { draft, setDraftField, status } from "../../stores/blueprints";

	type Props = { view: "new" | "edit" };

	let { view }: Props = $props();
</script>

<section id="general" class="form-section">
	<header>
		<span>01</span>
		<div>
			<h2>General</h2>
			<p>Name and describe this reusable agent definition.</p>
		</div>
	</header>
	<div class="field-grid two">
		<label
			><span>Blueprint ID</span><input
				value={$draft.id} oninput={(event) => setDraftField("id", event.currentTarget.value)}
				disabled={view === "edit" || $status.loading}
				placeholder="researcher"
				autocomplete="off"
			/><small>Letters, numbers, hyphens, and underscores.</small
			></label
		><label
			><span>Description</span><input
				value={$draft.description} oninput={(event) => setDraftField("description", event.currentTarget.value)}
				disabled={$status.loading}
				placeholder="Researches and verifies technical claims"
			/></label
		>
	</div>
</section>
