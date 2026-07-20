<script lang="ts">
	/*
	 * Raised after a provider is created, changed, or deleted.
	 *
	 * Provider instances and model discovery are built when Nox starts, so a
	 * saved change is inert until then. Without this the library would look
	 * wrong rather than stale: the provider appears, but reports no models and
	 * an inactive status.
	 */
	type Props = { ondismiss: () => void };

	let { ondismiss }: Props = $props();
</script>

<div class="restart-banner" role="status">
	<span class="restart-icon" aria-hidden="true">↻</span>
	<div>
		<strong>Restart Nox to apply provider changes</strong>
		<p>The configuration is saved locally. Runtime status and discovered models update after restart.</p>
	</div>
	<button type="button" aria-label="Dismiss restart notice" onclick={ondismiss}>×</button>
</div>

<style>
	.restart-banner {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr) 28px;
		align-items: center;
		gap: 11px;
		margin-bottom: 12px;
		padding: 11px 12px;
		background: linear-gradient(100deg, #272116, #1b1913);
		border: 1px solid #443a26;
		border-radius: 8px;
	}
	.restart-icon {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 19%);
		border-radius: 7px;
		color: var(--accent);
		font-size: 16px;
	}
	.restart-banner strong,
	.restart-banner p { display: block; }
	.restart-banner strong {
		font-size: 11px;
		font-weight: 600;
	}
	.restart-banner p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 9px;
	}
	.restart-banner > button {
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 5px;
		color: var(--muted);
		cursor: pointer;
		font-size: 18px;
	}
	.restart-banner > button:hover {
		background: rgb(255 255 255 / 4%);
		color: var(--text);
	}

	/* The notice is dismissible but not essential; on narrow screens the copy
	   keeps the space and the close button goes. */
	@media (max-width: 620px) {
		.restart-banner { grid-template-columns: 32px minmax(0, 1fr); }
		.restart-banner > button { display: none; }
	}
</style>
