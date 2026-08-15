<script lang="ts">
	/*
	 * Confirmation that a form saved, with a note on when the change applies.
	 *
	 * Most Nox configuration does not take effect immediately — some settings
	 * reach only new sessions, others need a restart — so the follow-up line is
	 * required rather than optional: "saved" alone would imply the change is
	 * already live.
	 */
	type Props = {
		detail: string;
		title: string;
	};

	let { detail, title }: Props = $props();
</script>

<div class="form-saved" role="status">
	<span>✓</span>
	<div>
		<strong>{title}</strong>
		<p>{detail}</p>
	</div>
</div>
