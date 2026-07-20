<script lang="ts">
	/*
	 * The system prompt every session on this blueprint starts from.
	 *
	 * The character count is shown because prompts compete with the context
	 * window: it is the one property of this field the model actually reacts to.
	 */
	import { draft, setDraftField, status } from "../../stores/blueprints";
</script>

<section id="instructions" class="form-section">
	<header>
		<span>02</span>
		<div>
			<h2>Instructions</h2>
			<p>Define the behavior that every session starts with.</p>
		</div>
	</header>
	<label
		><span>System instructions</span><textarea
			value={$draft.systemPrompt} oninput={(event) => setDraftField("systemPrompt", event.currentTarget.value)}
			disabled={$status.loading}
			rows="9"
			placeholder="You investigate claims, cite evidence, and make uncertainty explicit…"
		></textarea><small
			>{$draft.systemPrompt.length.toLocaleString()} characters</small
		></label
	>
</section>
