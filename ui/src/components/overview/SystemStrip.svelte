<script lang="ts">
	/*
	 * Whether the daemon is answering, and the headline counts when it is.
	 *
	 * This gates everything below it: with the daemon down the rest of the page
	 * has no data to show, so the strip carries its own retry rather than
	 * leaving the panels to fail one by one.
	 */
	import { blueprints, providers } from "../../stores/catalog";
	import { refreshOverview, sessions, status } from "../../stores/overview";
	const providerCount = $derived($providers.length);
</script>

{#if $status.loading}
	<div class="system-strip skeleton-strip" aria-label="Loading system status"><div class="skeleton-line wide"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
{:else}
	<div class:offline={!$status.daemonOnline} class="system-strip">
		<div class="system-primary">
			<span class:healthy={$status.daemonOnline} class="status-orb"></span>
			<div><strong>{$status.daemonOnline ? 'Nox is available' : 'Nox daemon is offline'}</strong><span>{$status.daemonOnline ? 'API responding from the local workbench' : 'Start the daemon to load workbench data'}</span></div>
		</div>
		{#if $status.daemonOnline}
			<div class="system-facts"><span><strong>{$blueprints.length}</strong> blueprints</span><span><strong>{providerCount}</strong> providers</span><span><strong>{$sessions.length}</strong> saved sessions</span></div>
		{:else}
			<button class="button danger-quiet" type="button" onclick={refreshOverview}>Try again</button>
		{/if}
	</div>
{/if}

<style>
	/* ------------------------------------------------------- system strip */

	.system-strip {
		display: flex;
		min-height: 70px;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding: 13px 16px;
		background: linear-gradient(110deg, #141c16, var(--surface-raised));
		border: 1px solid #27372c;
		border-radius: 8px;
	}
	.system-strip.offline {
		background: linear-gradient(110deg, #1c1413, #151211);
		border-color: #3b2523;
	}
	.system-primary {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.system-primary strong,
	.system-primary span { display: block; }
	.system-primary strong {
		font-size: 13px;
		font-weight: 620;
	}
	.system-primary span:not(.status-orb) {
		margin-top: 2px;
		color: var(--muted);
		font-size: 11px;
	}
	.status-orb {
		width: 9px;
		height: 9px;
		background: var(--danger);
		border-radius: 50%;
		box-shadow: 0 0 0 5px rgb(216 120 114 / 8%);
	}
	.status-orb.healthy {
		background: var(--healthy);
		box-shadow: 0 0 0 5px rgb(105 180 134 / 9%);
	}
	.system-facts {
		display: flex;
		align-items: center;
		color: var(--muted);
		font-size: 11px;
	}
	.system-facts span {
		padding: 0 16px;
		border-left: 1px solid var(--border);
	}
	.system-facts strong {
		margin-right: 3px;
		color: var(--text);
		font-family: var(--font-mono-explicit);
		font-size: 12px;
		font-weight: 550;
	}


	/* Shimmer placeholders for the strip itself, before the first response. */
	.skeleton-strip,
	.skeleton-line {
		background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.35s infinite linear;
	}
	.skeleton-strip { flex-direction: row; }
	.skeleton-line {
		width: 100px;
		height: 10px;
		border-radius: 4px;
	}
	.skeleton-line.wide { width: 240px; }

	@media (max-width: 620px) {
		.system-strip {
			align-items: flex-start;
			flex-direction: column;
		}
		.system-facts { width: 100%; }
		.system-facts span {
			flex: 1;
			padding: 0 8px;
			text-align: center;
		}
		.system-facts span:first-child {
			padding-left: 0;
			border-left: 0;
		}
	}
</style>
