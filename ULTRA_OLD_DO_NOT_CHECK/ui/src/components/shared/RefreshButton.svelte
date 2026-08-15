<script lang="ts">
	/*
	 * Reload control for the polled views (overview, runs, sessions, logs).
	 *
	 * `refreshing` distinguishes a background reload — which spins the icon but
	 * leaves the current data on screen — from the initial `loading`, where
	 * there is nothing to refresh yet. Both disable the button.
	 */
	type Props = {
		loading?: boolean;
		onrefresh: () => void;
		refreshing?: boolean;
	};

	let { loading = false, onrefresh, refreshing = false }: Props = $props();
</script>

<button class="button secondary" type="button" onclick={onrefresh} disabled={loading || refreshing}>
	<svg class:spinning={refreshing} aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
	{refreshing ? "Refreshing" : "Refresh"}
</button>
