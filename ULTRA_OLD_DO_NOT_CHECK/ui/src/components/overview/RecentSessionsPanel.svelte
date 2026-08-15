<script lang="ts">
	/*
	 * The most recently active sessions, as shortcuts back into the Playground.
	 *
	 * Deliberately short — the Sessions workbench is where history is browsed;
	 * this is only for picking up what was last worked on.
	 */
	import Avatar from "../shared/Avatar.svelte";
	import { formatRelativeTime, shortId } from "../../utils/format";
	import { recentSessions, sessions, status } from "../../stores/overview";
</script>

<section class="panel sessions-panel">
	<header class="panel-heading"><div><span class="panel-kicker">Local history</span><h2>Recent sessions</h2></div>{#if $sessions.length > 4}<span class="subtle-count">{$sessions.length} total</span>{/if}</header>
	{#if $status.loading}
		<div class="session-list loading-list">{#each [1, 2, 3] as _}<div class="session-row"><div class="skeleton-avatar"></div><div class="skeleton-copy"><span></span><span></span></div></div>{/each}</div>
	{:else if $recentSessions.length > 0}
		<div class="session-list">{#each $recentSessions as session}<a class="session-row" href={`/playground?session=${encodeURIComponent(session.sessionId)}`}><Avatar kind="blueprint" seed={`blueprint:${session.blueprintId}`} label={session.blueprintId} size={29} /><div class="session-copy"><strong>{session.blueprintId}</strong><span><code>{shortId(session.sessionId)}</code> · {formatRelativeTime(session.updatedAt)}</span></div><span class="origin-badge">WEB</span></a>{/each}</div>
	{:else}
		<div class="empty-state compact"><div class="empty-mark"><span></span><span></span><span></span></div><strong>No sessions yet</strong><p>Your locally stored conversations will appear here.</p></div>
	{/if}
</section>
