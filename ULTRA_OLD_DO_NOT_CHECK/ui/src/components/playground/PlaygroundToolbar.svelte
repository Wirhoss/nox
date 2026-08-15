<script lang="ts">
	import {
		blueprints,
		blueprintSessions,
		createSession,
		currentSession,
		openSession,
		run,
		selectBlueprint,
		selectedBlueprintId,
		status,
	} from "../../stores/playground";
	import { formatTime, shortId } from "../../utils/format";

	type Props = { onclear: () => void; ondelete: () => void };

	let { onclear, ondelete }: Props = $props();
</script>

<header class="playground-topline">
	<div class="playground-title"><span class="eyebrow">Operate</span><h1>Playground</h1></div>
	<div class="playground-controls">
		<label>
			<span>Blueprint</span>
			<select
				value={$selectedBlueprintId}
				onchange={(event) => selectBlueprint(event.currentTarget.value)}
				disabled={$status.loading || $run.active}
			>
				<option value="">Select blueprint…</option>
				{#each $blueprints as blueprint}<option value={blueprint.id}>{blueprint.id}</option>{/each}
			</select>
		</label>
		<label>
			<span>Session</span>
			<select
				value={$currentSession?.sessionId ?? ""}
				onchange={(event) => event.currentTarget.value && openSession(event.currentTarget.value)}
				disabled={!$selectedBlueprintId || $run.active}
			>
				<option value="">New scratch session</option>
				{#each $blueprintSessions as session}
					<option value={session.sessionId}>{shortId(session.sessionId)} · {formatTime(session.updatedAt)}</option>
				{/each}
			</select>
		</label>
		<button
			class="button secondary"
			type="button"
			onclick={createSession}
			disabled={!$selectedBlueprintId || $status.creating || $run.active}
		>
			{$status.creating ? "Starting…" : "+ New session"}
		</button>
		<button class="button secondary" type="button" onclick={onclear} disabled={!$currentSession || $run.active}>
			Clear
		</button>
		<button class="button danger-outline" type="button" onclick={ondelete} disabled={!$currentSession || $run.active}>
			Delete
		</button>
	</div>
</header>

<style>
	.playground-topline {
		display: flex;
		min-height: 74px;
		align-items: center;
		justify-content: space-between;
		gap: 22px;
		padding: 12px 22px;
		background: rgb(14 18 15 / 87%);
		border-bottom: 1px solid var(--border);
		backdrop-filter: blur(15px);
	}
	.playground-title {
		display: flex;
		flex: 0 0 auto;
		align-items: baseline;
		gap: 9px;
	}
	.playground-title h1 {
		margin: 0;
		font-size: 18px;
		font-weight: 580;
		letter-spacing: -.02em;
	}
	.playground-controls {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	/* The label is the visible control shell; the select inside is chromeless. */
	.playground-controls label {
		display: flex;
		height: 34px;
		align-items: center;
		gap: 7px;
		padding-left: 9px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		font-size: 9px;
	}
	.playground-controls select {
		width: 148px;
		height: 32px;
		padding: 0 24px 0 0;
		background: transparent;
		border: 0;
		outline: 0;
		color: var(--text);
		font-size: 10px;
	}
	/* The session picker shows ids, which are longer and monospaced. */
	.playground-controls label:nth-child(2) select {
		width: 190px;
		font-family: var(--font-mono);
		font-size: 9px;
	}

	@media (max-width: 900px) {
		.playground-topline {
			align-items: flex-start;
			flex-direction: column;
		}
		.playground-controls {
			width: 100%;
			justify-content: flex-start;
			flex-wrap: wrap;
		}
		.playground-controls label { flex: 1; }
		.playground-controls select,
		.playground-controls label:nth-child(2) select { width: 100%; }
	}

	@media (max-width: 620px) {
		.playground-topline { padding: 13px 14px; }
		.playground-title { width: 100%; }
		.playground-controls label { flex: 1 1 100%; }
		.playground-controls .button { flex: 1; }
	}
</style>
