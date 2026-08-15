<script lang="ts">
	/*
	 * Inline validation or save failure inside a form.
	 *
	 * Distinct from `ErrorState`: that one replaces a view that has no data,
	 * this one sits beside a form the user can still correct and resubmit.
	 * Styling comes from `.form-error` in forms.css.
	 */
	type Props = { message: string };

	let { message }: Props = $props();
</script>

<div class="form-error" role="alert">
	<span>!</span>
	<p>{message}</p>
</div>
