<script lang="ts">
	/*
	 * The registered tool sets, as reported by the runtime.
	 *
	 * Read-only for the same reason as the broker list: tools arrive as code.
	 * Which of them an agent may call is a per-blueprint decision, and whether
	 * a call needs approval is the policy form further down.
	 */
	import { tools } from "../../stores/catalog";
	import { filteredToolSets, status } from "../../stores/settings";
</script>

<div class="settings-subsection">
	<div class="settings-subheading"><div><h3>Registered tool sets</h3><p>Read-only runtime inventory</p></div></div>
	{#if $status.loading}
		<div class="capability-list">{#each [1, 2] as _}<div class="capability-row"><span class="table-skeleton short"></span><span class="table-skeleton long"></span></div>{/each}</div>
	{:else if $tools.length === 0}
			<div class="settings-empty"><span>⌘</span><div><strong>No tool sets registered</strong><p>Installed tool extensions will appear here automatically.</p></div></div>
	{:else if $filteredToolSets.length === 0}
			<div class="settings-empty"><span>⌕</span><div><strong>No matching tool sets</strong><p>Try another name or service.</p></div></div>
		{:else}
			<div class="capability-list">
				{#each $filteredToolSets as toolSet}
				<div class="capability-row"><div class="capability-mark tool">⌘</div><div class="capability-copy"><strong>{toolSet}</strong><span>Registered by the runtime</span></div><span class="capability-origin">INSTALLED</span><span class="capability-status"><i></i> Available</span></div>
			{/each}
		</div>
	{/if}
	</div>
