<script lang="ts">
	import type { Blueprint, CreateDeliberation } from "../../utils/types";
	import ParticipantPicker from "./ParticipantPicker.svelte";

	type Props = {
		blueprints: readonly Blueprint[];
		draft: CreateDeliberation;
		error: string;
		formError: string;
		loading: boolean;
		onsave: () => void;
		onfield: <Key extends keyof CreateDeliberation>(key: Key, value: CreateDeliberation[Key]) => void;
		saving: boolean;
	};

	let { blueprints, draft, error, formError, loading, onsave, onfield, saving }: Props = $props();

	const submit = (event: SubmitEvent): void => {
		event.preventDefault();
		onsave();
	};
</script>

<section class="deliberation-creator">
	<a class="back-link" href="/deliberation">← Back to Deliberation</a>
	<header class="page-heading workbench-heading">
		<div><div class="eyebrow">New deliberation</div><h1>Configure the room</h1><p>Frame the decision, assemble the participants, and choose how the final decision is moderated.</p></div>
	</header>

	{#if error}<div class="form-banner error"><strong>Setup unavailable</strong><span>{error}</span></div>{/if}
	{#if !loading && blueprints.length < 2}<div class="form-banner warning"><strong>More blueprints required</strong><span>Create at least two blueprints before starting a deliberation.</span></div>{/if}

	<form onsubmit={submit}>
		<main>
			<section class="form-section setup-section">
				<header><span>01</span><div><h2>Decision</h2><p>Define one question whose outcome can be evaluated.</p></div></header>
				<div class="field-grid">
					<label><span>Title</span><input maxlength="120" placeholder="Memory architecture" value={draft.title} oninput={(event) => onfield("title", event.currentTarget.value)} /></label>
					<label><span>Decision question</span><textarea maxlength="4000" placeholder="Which memory architecture should we adopt, and under which constraints?" value={draft.question} oninput={(event) => onfield("question", event.currentTarget.value)}></textarea><small>Include constraints and what a useful recommendation must resolve.</small></label>
				</div>
			</section>

			<section class="form-section setup-section">
				<header><span>02</span><div><h2>Participants</h2><p>Select two to eight independent perspectives.</p></div></header>
				<ParticipantPicker {blueprints} selected={draft.participantBlueprintIds} onchange={(selected: string[]) => onfield("participantBlueprintIds", selected)} />
			</section>

			<section class="form-section setup-section">
				<header><span>03</span><div><h2>Protocol</h2><p>Choose the moderator and the maximum number of rounds.</p></div></header>
				<div class="protocol-grid">
					<label><span>Moderator blueprint <b>Required</b></span><select required value={draft.moderatorBlueprintId} onchange={(event) => onfield("moderatorBlueprintId", event.currentTarget.value)}><option value="">Select a moderator…</option>{#each blueprints as blueprint}<option value={blueprint.id}>{blueprint.id}</option>{/each}</select><small>The moderator evaluates consensus and produces the final synthesis.</small></label>
					<label><span>Maximum rounds</span><input type="number" min="1" max="100" step="1" value={draft.rounds} oninput={(event) => onfield("rounds", Math.max(1, Math.min(100, Number.parseInt(event.currentTarget.value, 10) || 1)))} /><small>Enter any value from 1 to 100. The process may stop earlier when consensus is verified.</small></label>
				</div>
			</section>
		</main>

		<aside>
			<div class="review-panel">
				<span class="panel-kicker">Ready room</span>
				<h2>{draft.title.trim() || "Untitled deliberation"}</h2>
				<div class="review-question">{draft.question.trim() || "The decision question will appear here."}</div>
				<dl><div><dt>Participants</dt><dd>{draft.participantBlueprintIds.length}</dd></div><div><dt>Moderator</dt><dd>{draft.moderatorBlueprintId || "Not selected"}</dd></div><div><dt>Maximum rounds</dt><dd>{draft.rounds}</dd></div></dl>
				{#if formError}<div class="inline-error">{formError}</div>{/if}
				<button class="button primary" type="submit" disabled={loading || saving || blueprints.length < 2}>{saving ? "Creating…" : "Create deliberation"}</button>
				<a class="button secondary" href="/deliberation">Cancel</a>
			</div>
		</aside>
	</form>
</section>

<style>
	.deliberation-creator{margin-top:-5px}.deliberation-creator>.page-heading{margin-top:13px}.form-banner{display:flex;gap:10px;margin-bottom:12px;padding:11px 13px;border:1px solid var(--border);border-radius:7px;font-size:9px}.form-banner strong{color:var(--text)}.form-banner span{color:var(--secondary)}.form-banner.error{background:var(--danger-soft);border-color:rgb(216 120 114 / 22%)}.form-banner.warning{background:var(--accent-soft);border-color:rgb(208 164 92 / 22%)}form{display:grid;grid-template-columns:minmax(0,1fr) 300px;align-items:start;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}form>main{min-width:0;border-right:1px solid var(--border)}.setup-section{padding:24px;border-bottom:1px solid var(--border)}.setup-section:last-child{border-bottom:0}.setup-section>header{display:grid;grid-template-columns:28px 1fr;gap:10px;margin-bottom:18px}.setup-section>header>span{display:grid;width:24px;height:24px;place-items:center;background:rgb(170 139 194 / 10%);border:1px solid rgb(170 139 194 / 20%);border-radius:6px;color:#bda3d1;font:8px var(--font-mono)}.setup-section h2{margin:0;font-size:13px;font-weight:600}.setup-section header p{margin:3px 0 0;color:var(--muted);font-size:9px}.setup-section textarea{min-height:125px}.protocol-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.protocol-grid>label>span{display:block;margin-bottom:7px;color:var(--secondary);font-size:9px;font-weight:580}.protocol-grid>label>span b{float:right;color:var(--accent);font-size:7px;text-transform:uppercase;letter-spacing:.06em}.protocol-grid small{display:block;margin-top:7px;color:var(--muted);font-size:8px;line-height:1.45}.review-panel{position:sticky;top:calc(var(--topbar-height) + 18px);padding:22px}.review-panel h2{margin:5px 0 12px;font-size:16px;font-weight:580}.review-question{max-height:120px;padding:12px;overflow:auto;background:var(--surface-sunken);border:1px solid var(--border);border-radius:6px;color:var(--secondary);font-size:9px;line-height:1.55;white-space:pre-wrap}.review-panel dl{margin:17px 0}.review-panel dl>div{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}.review-panel dt{color:var(--muted);font-size:8px}.review-panel dd{max-width:150px;margin:0;overflow:hidden;color:var(--text);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.review-panel>.button{width:100%;margin-top:8px}.inline-error{margin:0 0 8px;padding:9px;background:var(--danger-soft);border-radius:6px;color:var(--danger-text);font-size:8px;line-height:1.4}@media(max-width:950px){form{grid-template-columns:1fr}form>main{border-right:0;border-bottom:1px solid var(--border)}.review-panel{position:static}}@media(max-width:680px){.protocol-grid{grid-template-columns:1fr}.setup-section{padding:18px}}
</style>
