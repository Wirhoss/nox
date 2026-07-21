<script lang="ts">
	import { onMount } from "svelte";
	import { blueprints } from "../../stores/catalog";
	import { cancel, configure, detail, loadDetail, start, status } from "../../stores/deliberation";
	import { formatTime } from "../../utils/format";
	import Avatar from "../shared/Avatar.svelte";
	import Markdown from "../shared/Markdown.svelte";
	import ParticipantPicker from "./ParticipantPicker.svelte";

	let deliberationId = $state("");
	let configuredFor = $state("");
	let participantBlueprintIds = $state<string[]>([]);
	let moderatorBlueprintId = $state("");
	let rounds = $state(2);

	const isConfigured = $derived(($detail?.participantBlueprintIds.length ?? 0) >= 2 && Boolean($detail?.moderatorBlueprintId));
	const progress = $derived($detail ? Math.min(100, Math.round(($detail.currentRound / Math.max(1, $detail.rounds)) * 86)) : 0);
	const participantName = (id: string): string => $blueprints.find((blueprint) => blueprint.id === id)?.id ?? id;

	$effect(() => {
		if ($detail && configuredFor !== $detail.deliberationId) {
			configuredFor = $detail.deliberationId;
			participantBlueprintIds = [...$detail.participantBlueprintIds];
			moderatorBlueprintId = $detail.moderatorBlueprintId ?? "";
			rounds = $detail.rounds;
		}
	});

	const saveConfiguration = async (): Promise<void> => {
		if (!deliberationId) return;
		await configure(deliberationId, { moderatorBlueprintId, participantBlueprintIds, rounds });
	};

	onMount(() => {
		deliberationId = new URLSearchParams(window.location.search).get("id") ?? "";
		if (!deliberationId) {
			status.setKey("error", "No deliberation id was provided.");
			status.setKey("loading", false);
			return;
		}
		void loadDetail(deliberationId);
		const timer = window.setInterval(() => {
			if ($detail?.status === "active") void loadDetail(deliberationId, true);
		}, 1500);
		return () => window.clearInterval(timer);
	});
</script>

<section class="deliberation-detail">
	<a class="back-link" href="/deliberation">← Back to Deliberation</a>
	{#if $status.loading}
		<div class="detail-loading"><span></span><span></span><span></span></div>
	{:else if $status.error || !$detail}
		<div class="detail-error"><strong>Deliberation unavailable</strong><p>{$status.error || "The requested deliberation was not found."}</p><a class="button secondary" href="/deliberation">Return to library</a></div>
	{:else}
		<header class="detail-heading">
			<div><div class="eyebrow">Structured decision</div><h1>{$detail.title}</h1><p>{$detail.question}</p></div>
			<div class="detail-actions">
				<span class={`activity-status ${$detail.status}`}>{$detail.status}</span>
				{#if $detail.status === "active"}<button class="button secondary" disabled={$status.action !== ""} onclick={() => void cancel($detail!.deliberationId)}>{$status.action === "cancelling" ? "Cancelling…" : "Cancel"}</button>
				{:else if $detail.status !== "completed" && isConfigured}<button class="button primary" disabled={$status.action !== ""} onclick={() => void start($detail!.deliberationId)}>{$status.action === "starting" ? "Starting…" : $detail.status === "draft" ? "Start deliberation" : "Run again"}</button>{/if}
			</div>
		</header>

		{#if $status.actionError}<div class="action-error">{$status.actionError}</div>{/if}

		<div class="detail-layout">
			<main>
				{#if $detail.status === "active"}
					<section class="progress-panel"><div class="progress-copy"><span>Deliberation in progress</span><strong>{$detail.currentRound === 0 ? "Preparing participants" : `Round ${$detail.currentRound} of ${$detail.rounds} maximum`}</strong></div><div class="progress-track"><i style={`width:${progress}%`}></i></div><small>After each critique round, the moderator checks whether any blocking objection remains.</small></section>
				{/if}

				{#if $detail.finalReport}
					<section class="report-panel"><header><span>Final synthesis</span><strong>{$detail.consensusReached ? `Consensus reached in round ${$detail.currentRound}` : "Maximum rounds reached"} · {$detail.moderatorBlueprintId}</strong></header><div class="report-content"><Markdown source={$detail.finalReport} /></div></section>
				{/if}

				{#if $detail.error}<section class="run-error"><strong>Execution failed</strong><p>{$detail.error}</p></section>{/if}

				<section class="record-panel">
					<header><div><span class="panel-kicker">Deliberation record</span><h2>Rounds and interventions</h2></div><small>{$detail.turns.length} {$detail.turns.length === 1 ? "intervention" : "interventions"}</small></header>
					{#if $detail.turns.length === 0}<div class="empty-record"><strong>No interventions yet</strong><p>Start the deliberation to collect independent proposals, critiques, and the moderated synthesis.</p></div>
					{:else}<div class="turn-list">{#each $detail.turns as turn}<article class:synthesis={turn.phase === "synthesis"} class:checkpoint={turn.phase === "consensus"}><header><Avatar decorative seed={turn.blueprintId} size={27} /><div><strong>{participantName(turn.blueprintId)}</strong><small>{turn.phase === "proposal" ? "Initial proposal" : turn.phase === "critique" ? `Critique · round ${turn.round}` : turn.phase === "consensus" ? `Consensus checkpoint · round ${turn.round}` : "Final synthesis"}</small></div><time>{formatTime(turn.createdAt)}</time></header><div class="turn-content"><Markdown source={turn.content} /></div><footer><span>Session</span><a href={`/sessions?id=${encodeURIComponent(turn.sessionId)}`}>{turn.sessionId.slice(0, 12)}</a></footer></article>{/each}</div>{/if}
				</section>
			</main>

			<aside>
				<section class="configuration-panel">
					<span class="panel-kicker">Protocol</span><h2>{isConfigured ? "Room configuration" : "Complete setup"}</h2>
					{#if $detail.status !== "active" && $detail.status !== "completed"}
						<label><span>Participants</span><ParticipantPicker blueprints={$blueprints} selected={participantBlueprintIds} onchange={(selected: string[]) => participantBlueprintIds = selected} /></label>
						<label><span>Moderator · required</span><select required bind:value={moderatorBlueprintId}><option value="">Select…</option>{#each $blueprints as blueprint}<option value={blueprint.id}>{blueprint.id}</option>{/each}</select></label>
						<label><span>Maximum rounds</span><input type="number" min="1" max="100" step="1" bind:value={rounds} /></label>
						<button class="button secondary" disabled={$status.action !== ""} onclick={() => void saveConfiguration()}>{$status.action === "configuring" ? "Saving…" : "Save configuration"}</button>
					{:else}
						<dl><div><dt>Participants</dt><dd>{$detail.participantBlueprintIds.length}</dd></div><div><dt>Moderator</dt><dd>{$detail.moderatorBlueprintId}</dd></div><div><dt>Maximum rounds</dt><dd>{$detail.rounds}</dd></div><div><dt>Executed rounds</dt><dd>{$detail.currentRound || "—"}</dd></div><div><dt>Result</dt><dd>{$detail.terminationReason === "consensus" ? "Consensus" : $detail.terminationReason === "max_rounds" ? "Max rounds" : "—"}</dd></div><div><dt>Started</dt><dd>{$detail.startedAt ? formatTime($detail.startedAt) : "—"}</dd></div></dl>
						<div class="participant-list">{#each $detail.participantBlueprintIds as id}<span><Avatar decorative seed={id} size={20} />{participantName(id)}</span>{/each}</div>
					{/if}
				</section>
			</aside>
		</div>
	{/if}
</section>

<style>
	.deliberation-detail{margin-top:-5px}.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:22px;margin:14px 0 20px}.detail-heading h1{margin:5px 0 6px;font-size:25px;font-weight:580}.detail-heading p{max-width:760px;margin:0;color:var(--secondary);font-size:11px;line-height:1.55;white-space:pre-wrap}.detail-actions{display:flex;align-items:center;gap:9px}.activity-status{padding:5px 9px;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;color:var(--muted);font:8px var(--font-mono);text-transform:uppercase}.activity-status.active{color:var(--accent);border-color:rgb(208 164 92 / 25%)}.activity-status.completed{color:var(--healthy);border-color:rgb(105 180 134 / 25%)}.activity-status.failed{color:var(--danger-text)}.detail-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;align-items:start;gap:14px}.detail-layout>main{display:grid;gap:14px}.progress-panel,.report-panel,.record-panel,.configuration-panel,.run-error{background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.progress-panel{padding:17px}.progress-copy{display:flex;align-items:center;justify-content:space-between}.progress-copy span{color:var(--secondary);font-size:9px}.progress-copy strong{color:var(--accent);font-size:10px}.progress-track{height:5px;margin:12px 0 8px;overflow:hidden;background:var(--surface-sunken);border-radius:4px}.progress-track i{display:block;height:100%;background:linear-gradient(90deg,var(--violet),var(--accent));border-radius:4px;transition:width .35s ease}.progress-panel small{color:var(--muted);font-size:8px}.report-panel{border-color:rgb(170 139 194 / 25%)}.report-panel>header,.record-panel>header{display:flex;align-items:center;justify-content:space-between;padding:14px 17px;border-bottom:1px solid var(--border)}.report-panel>header span{color:#c6add8;font-size:10px;font-weight:650}.report-panel>header strong{color:var(--muted);font-size:8px}.report-content{padding:20px;color:var(--secondary);font-size:10px;line-height:1.65}.record-panel>header h2{margin:4px 0 0;font-size:13px}.record-panel>header small{color:var(--muted);font-size:8px}.turn-list{display:grid;gap:9px;padding:12px}.turn-list article{background:var(--surface-sunken);border:1px solid var(--border);border-radius:7px}.turn-list article.synthesis{border-color:rgb(170 139 194 / 24%)}.turn-list article>header{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--border)}.turn-list header strong,.turn-list header small{display:block}.turn-list header strong{font-size:9px}.turn-list header small,.turn-list time{margin-top:2px;color:var(--muted);font-size:8px}.turn-content{padding:14px;color:var(--secondary);font-size:9px;line-height:1.6}.turn-list footer{display:flex;gap:7px;padding:8px 13px;border-top:1px solid var(--border);color:var(--muted);font:7px var(--font-mono)}.turn-list footer a{color:var(--secondary)}.empty-record{padding:36px;text-align:center}.empty-record strong{font-size:11px}.empty-record p{max-width:430px;margin:6px auto 0;color:var(--muted);font-size:9px;line-height:1.5}.configuration-panel{position:sticky;top:calc(var(--topbar-height) + 16px);padding:18px}.configuration-panel h2{margin:4px 0 16px;font-size:14px}.configuration-panel label{display:block;margin-top:13px}.configuration-panel label>span{display:block;margin-bottom:6px;color:var(--secondary);font-size:8px;font-weight:600}.compact-options{display:grid;gap:5px}.compact-options button{display:flex;align-items:center;gap:7px;width:100%;padding:7px;background:var(--surface-sunken);border:1px solid var(--border);border-radius:5px;color:var(--secondary);font-size:8px;text-align:left;cursor:pointer}.compact-options button.selected{border-color:rgb(170 139 194 / 32%);color:var(--text)}.compact-options i{display:grid;width:16px;height:16px;place-items:center;background:var(--surface-2);border-radius:4px;font-style:normal}.compact-options b{overflow:hidden;text-overflow:ellipsis}.configuration-panel>.button{width:100%;margin-top:15px}.configuration-panel dl{margin:0}.configuration-panel dl>div{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}.configuration-panel dt{color:var(--muted);font-size:8px}.configuration-panel dd{max-width:145px;margin:0;overflow:hidden;color:var(--text);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.participant-list{display:grid;gap:6px;margin-top:14px}.participant-list span{display:flex;align-items:center;gap:7px;color:var(--secondary);font-size:8px}.action-error,.run-error{margin-bottom:12px;padding:11px 13px;background:var(--danger-soft);border-color:rgb(216 120 114 / 22%);color:var(--danger-text);font-size:9px}.run-error p{margin:5px 0 0;color:var(--secondary)}.detail-loading{display:grid;gap:10px;padding:50px}.detail-loading span{height:12px;background:var(--surface-2);border-radius:5px}.detail-loading span:nth-child(2){width:70%}.detail-error{padding:30px;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.detail-error p{color:var(--secondary);font-size:10px}@media(max-width:880px){.detail-layout{grid-template-columns:1fr}.configuration-panel{position:static}}@media(max-width:640px){.detail-heading{flex-direction:column}.detail-actions{width:100%;justify-content:space-between}}
</style>
