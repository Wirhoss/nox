<script lang="ts">
	/*
	 * The four inventory counts across the top of the dashboard.
	 *
	 * Counts only — each card links nowhere, because the sidebar already owns
	 * navigation to these sections.
	 */
	import { blueprints, providers, tools } from "../../stores/catalog";
	import { sessions, status } from "../../stores/overview";
	const providerCount = $derived($providers.length);
</script>

<div class="metric-grid" aria-label="Workbench inventory">
	<div class="metric-card">
		<div class="metric-icon amber"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 14v6M14 17h6" /></svg></div>
		<div class="metric-value"><span>Blueprints</span><strong>{$status.loading ? '—' : $blueprints.length}</strong></div><span class="metric-note">Agent definitions</span>
	</div>
	<div class="metric-card">
		<div class="metric-icon blue"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 2v4M16 2v4M6 6h12v5a6 6 0 0 1-12 0ZM12 17v5" /></svg></div>
		<div class="metric-value"><span>Providers</span><strong>{$status.loading ? '—' : providerCount}</strong></div><span class="metric-note">Configured backends</span>
	</div>
	<div class="metric-card">
		<div class="metric-icon green"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-3-3Z" /></svg></div>
		<div class="metric-value"><span>Tool sets</span><strong>{$status.loading ? '—' : $tools.length}</strong></div><span class="metric-note">Runtime capabilities</span>
	</div>
	<div class="metric-card">
		<div class="metric-icon violet"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3v-7a4 4 0 0 1-1-2.65V7a4 4 0 0 1 4-4h11a4 4 0 0 1 4 4Z" /></svg></div>
		<div class="metric-value"><span>Sessions</span><strong>{$status.loading ? '—' : $sessions.length}</strong></div><span class="metric-note">Stored locally</span>
	</div>
</div>

<style>
	/* ------------------------------------------------------- metric cards */

	.metric-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
		margin-top: 12px;
	}
	/* Icon spans both rows on the left; value and note stack on the right. */
	.metric-card {
		display: grid;
		grid-template-columns: 38px 1fr;
		grid-template-rows: auto auto;
		column-gap: 11px;
		min-height: 86px;
		align-items: center;
		padding: 13px 14px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.metric-value {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.metric-value span {
		color: var(--secondary);
		font-size: 12px;
	}
	.metric-value strong {
		font-family: var(--font-mono-explicit);
		font-size: 21px;
		font-weight: 520;
		letter-spacing: -.04em;
	}
	.metric-note {
		align-self: start;
		color: var(--muted);
		font-size: 10px;
	}
	.metric-icon {
		grid-row: 1 / 3;
		display: grid;
		width: 36px;
		height: 36px;
		place-items: center;
		border: 1px solid;
		border-radius: 7px;
	}
	.metric-icon svg {
		width: 17px;
		height: 17px;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.6;
	}
	.metric-icon.amber {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 15%);
		color: var(--accent);
	}
	.metric-icon.blue {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 15%);
		color: var(--cloud);
	}
	.metric-icon.green {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 15%);
		color: var(--healthy);
	}
	.metric-icon.violet {
		background: #251d2b;
		border-color: rgb(170 139 194 / 15%);
		color: var(--violet);
	}

	@media (max-width: 1120px) {
		.metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	}
	@media (max-width: 620px) {
		.metric-grid { grid-template-columns: 1fr; }
		.metric-card { min-height: 75px; }
	}
</style>
