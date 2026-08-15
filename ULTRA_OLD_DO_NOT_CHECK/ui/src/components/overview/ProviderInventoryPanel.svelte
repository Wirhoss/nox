<script lang="ts">
	/*
	 * Configured providers and whether the runtime has them active.
	 *
	 * `inactive` here means configured but not built at startup — usually a
	 * provider added since the last restart.
	 */
	import { providers } from "../../stores/catalog";
	import { status } from "../../stores/overview";
	const providerCount = $derived($providers.length);
</script>

<section class="panel providers-panel">
	<header class="panel-heading"><div><span class="panel-kicker">Execution</span><h2>Provider inventory</h2></div></header>
	{#if !$status.loading && providerCount > 0}
		<div class="provider-list">{#each $providers as provider}<div class="provider-row"><div class="provider-logo">{provider.id.slice(0, 2).toUpperCase()}</div><div class="provider-copy"><strong>{provider.id}</strong><span>{provider.type.replaceAll('_', ' ')}</span></div><span class:inactive={provider.status === 'inactive'} class="origin-badge cloud">{provider.status}</span></div>{/each}</div>
	{:else if !$status.loading}
		<div class="empty-state compact"><div class="empty-provider">+</div><strong>No provider configured</strong><p>Add a model backend before creating runnable sessions.</p></div>
	{/if}
</section>
