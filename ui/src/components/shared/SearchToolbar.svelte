<script lang="ts">
	/*
	 * The search row above a library listing: a filter box and a result count.
	 *
	 * `value` is bindable so the owning view keeps the query — the filtering
	 * itself belongs to the view, which knows what its records are made of.
	 * Styling comes from `.library-toolbar` in workbench.css.
	 */
	type Props = {
		/** The right-hand count, already worded ("3 of 12", "Loading"). */
		count: string;
		label: string;
		placeholder: string;
		/**
		 * Set when the results below are separate cards rather than a table the
		 * toolbar joins onto, which changes how it is rounded off.
		 */
		standalone?: boolean;
		value: string;
	};

	let { count, label, placeholder, standalone = false, value = $bindable() }: Props = $props();
</script>

<div class="library-toolbar" class:standalone>
	<label class="library-search">
		<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
		<input bind:value {placeholder} aria-label={label} />
	</label>
	<span class="library-count">{count}</span>
</div>
