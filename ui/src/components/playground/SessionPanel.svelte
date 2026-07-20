<script lang="ts">
	import { blueprintSessions, currentSession, openSession, run, selectedBlueprint } from "../../stores/playground";
	import { formatTime, shortId } from "../../utils/format";
	import Avatar from "../shared/Avatar.svelte";

	/** Older sessions stay reachable from the Sessions page rather than here. */
	const VISIBLE_SESSIONS = 8;
</script>

<aside class="playground-session-panel">
	<div class="playground-panel-head">
		<span class="panel-kicker">Session</span>
		<h2>{$currentSession ? "Scratch session" : "Ready to start"}</h2>
	</div>

	{#if $selectedBlueprint}
		<div class="playground-blueprint-card">
			<Avatar
				kind="blueprint"
				seed={`blueprint:${$selectedBlueprint.id}`}
				label={$selectedBlueprint.id}
				size={32}
			/>
			<div>
				<strong>{$selectedBlueprint.id}</strong>
				<span>{$selectedBlueprint.description}</span>
			</div>
		</div>
		<div class="playground-facts">
			<div><span>Provider</span><strong>{$selectedBlueprint.config.providerId}</strong></div>
			<div><span>Model</span><strong>{$selectedBlueprint.config.modelId}</strong></div>
			<div><span>Tools</span><strong>{$selectedBlueprint.coreTools.length + $selectedBlueprint.lazyLoadedTools.length}</strong></div>
			<div><span>Turn limit</span><strong>{$selectedBlueprint.config.maxIterations}</strong></div>
		</div>
	{/if}

	<div class="session-history-heading">
		<span>Saved sessions</span>
		<strong>{$blueprintSessions.length}</strong>
	</div>
	<div class="playground-session-list">
		{#each $blueprintSessions.slice(0, VISIBLE_SESSIONS) as session}
			<button
				class:active={$currentSession?.sessionId === session.sessionId}
				type="button"
				onclick={() => openSession(session.sessionId)}
				disabled={$run.active}
			>
				<span class="session-pulse"></span>
				<div>
					<strong>{shortId(session.sessionId)}</strong>
					<small>{formatTime(session.updatedAt)}</small>
				</div>
			</button>
		{:else}
			<div class="session-list-empty">No saved sessions for this blueprint.</div>
		{/each}
	</div>
</aside>

<style>
	.playground-session-panel {
		min-width: 0;
		overflow-y: auto;
		background: rgb(16 20 17 / 90%);
		border-right: 1px solid var(--border);
	}
	.playground-panel-head {
		min-height: 66px;
		padding: 16px;
		border-bottom: 1px solid var(--border);
	}
	.playground-panel-head h2 {
		margin: 3px 0 0;
		font-size: 13px;
		font-weight: 580;
	}

	.playground-blueprint-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 15px;
		border-bottom: 1px solid var(--border);
	}
	.playground-blueprint-card > div { min-width: 0; }
	.playground-blueprint-card strong,
	.playground-blueprint-card span { display: block; }
	.playground-blueprint-card strong {
		overflow: hidden;
		font-size: 11px;
		font-weight: 580;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.playground-blueprint-card div span {
		margin-top: 2px;
		overflow: hidden;
		color: var(--muted);
		font-size: 8px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.playground-facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		padding: 8px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.playground-facts > div {
		min-width: 0;
		padding: 7px 0;
	}
	.playground-facts span,
	.playground-facts strong { display: block; }
	.playground-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.playground-facts strong {
		margin-top: 2px;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-history-heading {
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
	.playground-session-list { padding: 0 8px 12px; }
	.playground-session-list button {
		display: grid;
		grid-template-columns: 7px minmax(0, 1fr);
		width: 100%;
		min-height: 45px;
		align-items: center;
		gap: 8px;
		padding: 7px 8px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: var(--secondary);
		cursor: pointer;
		text-align: left;
	}
	.playground-session-list button:hover { background: var(--surface-2); }
	.playground-session-list button.active {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 12%);
		color: #e4c687;
	}
	.session-pulse {
		width: 5px;
		height: 5px;
		background: var(--muted);
		border-radius: 50%;
	}
	.playground-session-list button.active .session-pulse {
		background: var(--accent);
		box-shadow: 0 0 0 3px rgb(208 164 92 / 10%);
	}
	.playground-session-list strong,
	.playground-session-list small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.playground-session-list strong {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
	}
	.playground-session-list small {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	.session-list-empty {
		padding: 15px 8px;
		color: var(--muted);
		font-size: 9px;
		text-align: center;
	}

	/* Below this width the layout is a single column and the panel is dropped;
	   sessions stay reachable from the Sessions page. */
	@media (max-width: 900px) {
		.playground-session-panel { display: none; }
	}
</style>
