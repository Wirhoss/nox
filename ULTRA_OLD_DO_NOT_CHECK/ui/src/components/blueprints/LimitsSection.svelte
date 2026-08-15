<script lang="ts">
	/*
	 * The iteration ceiling for a single run.
	 *
	 * This is the backstop against a model that keeps calling tools without
	 * converging; a run that hits it ends with `maxIterations` rather than an
	 * error, because the output so far may still be usable.
	 */
	import { draft, setConfigField, status } from "../../stores/blueprints";
</script>

<section id="limits" class="form-section">
	<header>
		<span>05</span>
		<div>
			<h2>Limits</h2>
			<p>Bound how long one response can continue.</p>
		</div>
	</header>
	<label class="number-field"
		><span>Maximum iterations</span><input
			type="number"
			min="1"
			step="1"
			value={$draft.config.maxIterations} oninput={(event) => setConfigField("maxIterations", event.currentTarget.valueAsNumber)}
			disabled={$status.loading}
		/><small>Stops the run after this many model/tool turns.</small
		></label
	>
</section>
