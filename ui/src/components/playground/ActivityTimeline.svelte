<script lang="ts">
	import { activities } from "../../stores/playground";
	import { formatClockTime } from "../../utils/format";
	import { activityLabel } from "../../utils/messages";

	/** Newest first, capped to what fits the inspector column without scrolling. */
	const VISIBLE_ACTIVITIES = 8;

	const visible = $derived($activities.slice(-VISIBLE_ACTIVITIES).reverse());
</script>

<div class="activity-heading"><span>Live activity</span></div>
<div class="activity-timeline">
	{#each visible as activity}
		<div class="activity-item" class:error={activity.event.type === "error"}>
			<span></span>
			<div>
				<strong>{activityLabel(activity)}</strong>
				<small>{formatClockTime(activity.receivedAt)} · #{activity.cursor}</small>
			</div>
		</div>
	{:else}
		<div class="activity-empty">
			<span>···</span>
			<p>Run events will appear here.</p>
		</div>
	{/each}
</div>

<style>
	.activity-heading {
		display: flex;
		min-height: 38px;
		align-items: center;
		justify-content: space-between;
		padding: 0 15px;
		color: var(--muted);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.activity-timeline { padding: 0 15px; }
	.activity-item {
		position: relative;
		display: grid;
		grid-template-columns: 8px minmax(0, 1fr);
		min-height: 45px;
		gap: 8px;
		padding: 7px 0;
	}
	/* Connector line running between dots; suppressed on the last item. */
	.activity-item::before {
		position: absolute;
		top: 17px;
		bottom: -9px;
		left: 3px;
		border-left: 1px solid var(--border);
		content: '';
	}
	.activity-item:last-child::before { display: none; }
	.activity-item > span {
		z-index: 1;
		width: 7px;
		height: 7px;
		margin-top: 4px;
		background: var(--healthy);
		border: 2px solid var(--surface-1);
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgb(105 180 134 / 30%);
	}
	.activity-item.error > span {
		background: var(--danger);
		box-shadow: 0 0 0 1px rgb(216 120 114 / 30%);
	}
	.activity-item strong,
	.activity-item small { display: block; }
	.activity-item strong {
		overflow: hidden;
		font-size: 8px;
		font-weight: 550;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.activity-item small {
		margin-top: 2px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 7px;
	}
	.activity-empty {
		padding: 17px 5px;
		color: var(--muted);
		text-align: center;
	}
	.activity-empty span {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: .1em;
	}
	.activity-empty p {
		margin: 3px 0 0;
		font-size: 8px;
	}

	/* The inspector turns into a horizontal strip below this width, with no
	   room for the timeline. */
	@media (max-width: 1120px) {
		.activity-heading,
		.activity-timeline { display: none; }
	}
</style>
