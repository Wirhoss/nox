<script lang="ts">
	import { permissions, resolvePermission } from "../../stores/playground";
</script>

<div class="permission-dock">
	{#each $permissions as permission}
		<div class="permission-copy">
			<span class="permission-shield">!</span>
			<div>
				<span>Permission required</span>
				<strong>{permission.toolName}</strong>
				<p>{permission.reason}</p>
				<details>
					<summary>View arguments</summary>
					<pre>{JSON.stringify(permission.toolArguments, null, 2)}</pre>
				</details>
			</div>
		</div>
		<div class="permission-actions">
			<button class="button secondary" type="button" onclick={() => resolvePermission(permission, false)}>Deny</button>
			<button class="button primary" type="button" onclick={() => resolvePermission(permission, true)}>Allow once</button>
		</div>
	{/each}
</div>

<style>
	/* Amber slab pinned above the composer: the run is parked until answered. */
	.permission-dock {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 15px;
		margin: 0 16px 10px;
		padding: 12px;
		background: linear-gradient(110deg, #282116, #1a1711);
		border: 1px solid #4a3c25;
		border-radius: 7px;
		box-shadow: 0 12px 30px rgb(0 0 0 / 18%);
	}
	.permission-copy {
		display: flex;
		min-width: 0;
		align-items: flex-start;
		gap: 10px;
	}
	.permission-shield {
		display: grid;
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 22%);
		border-radius: 50%;
		color: var(--accent);
		font-size: 10px;
		font-weight: 700;
	}
	.permission-copy > div > span,
	.permission-copy strong { display: block; }
	.permission-copy > div > span {
		color: var(--accent);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.permission-copy strong {
		margin-top: 2px;
		font-size: 11px;
		font-weight: 590;
	}
	.permission-copy p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 9px;
	}
	.permission-copy details { margin-top: 6px; }
	.permission-copy summary {
		color: var(--secondary);
		cursor: pointer;
		font-size: 8px;
	}
	.permission-copy pre {
		max-height: 130px;
		margin: 7px 0 0;
		padding: 7px;
		overflow: auto;
		background: var(--code-bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 1.45;
		white-space: pre-wrap;
	}
	.permission-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 7px;
	}

	@media (max-width: 620px) {
		.permission-dock {
			align-items: stretch;
			flex-direction: column;
		}
		.permission-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.permission-actions .button { width: 100%; }
	}
</style>
