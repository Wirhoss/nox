<script lang="ts">
	/*
	 * Overview shell.
	 *
	 * A frame around six independent panels. Fetching and derivation live in
	 * `stores/overview.ts` and the shared `stores/catalog.ts`; the chrome the
	 * panels share lives in `styles/overview.css`, because they are separate
	 * components and scoped CSS would not reach them.
	 */
	import { onMount } from 'svelte';

	import RefreshButton from '../shared/RefreshButton.svelte';
	import { formatRelativeTime } from '../../utils/format';
	import { lastUpdated, refreshOverview, status } from '../../stores/overview';
	import MetricGrid from './MetricGrid.svelte';
	import ProviderInventoryPanel from './ProviderInventoryPanel.svelte';
	import RecentSessionsPanel from './RecentSessionsPanel.svelte';
	import SetupPanel from './SetupPanel.svelte';
	import SystemStrip from './SystemStrip.svelte';
	import TelemetryPanel from './TelemetryPanel.svelte';

	onMount(refreshOverview);
</script>

<svelte:head><meta name="color-scheme" content="dark" /></svelte:head>

<section class="overview-page">
	<header class="page-heading">
		<div>
			<div class="eyebrow">Control plane</div>
			<h1>Overview</h1>
			<p>Configure and observe the parts of Nox that are available today.</p>
		</div>
		<div class="page-actions">
			{#if $lastUpdated}<span class="last-updated">Updated {formatRelativeTime($lastUpdated.getTime())}</span>{/if}
			<RefreshButton loading={$status.loading} refreshing={$status.refreshing} onrefresh={refreshOverview} />
		</div>
	</header>

	<SystemStrip />

	<!-- A partial failure degrades to a notice; the daemon being down is the
	     strip's business, and replaces the page instead. -->
	{#if $status.error && $status.daemonOnline}
		<div class="inline-notice" role="status"><span>!</span>{$status.error}</div>
	{/if}

	<MetricGrid />

	<div class="overview-grid">
		<SetupPanel />
		<RecentSessionsPanel />
		<ProviderInventoryPanel />
		<TelemetryPanel />
	</div>
</section>
