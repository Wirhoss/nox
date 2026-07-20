<script lang="ts">
	type Copy = {
		backLabel: string;
		button: string;
		description: string;
		label: string;
		nextCoordination: string;
		nextCoordinationHelp: string;
		nextTeam: string;
		nextTeamHelp: string;
		outcomeHelp: string;
		outcomeLabel: string;
		outcomePlaceholder: string;
		pattern: string;
		titlePlaceholder: string;
	};
	type Props = {
		backPath: string;
		copy: Copy;
		error: string;
		formError: string;
		loading: boolean;
		onoutcome: (value: string) => void;
		onsave: () => void;
		ontitle: (value: string) => void;
		outcome: string;
		saving: boolean;
		title: string;
		tone: "research" | "deliberation";
	};

	let { backPath, copy, error, formError, loading, onoutcome, onsave, ontitle, outcome, saving, title, tone }: Props = $props();
	const submit = (event: SubmitEvent): void => { event.preventDefault(); onsave(); };
</script>

<section class="activity-creator">
	<a class="back-link" href={backPath}>← Back to {copy.backLabel}</a>
	<header class="creator-heading"><div><span class="eyebrow">New {copy.label}</span><h1>Start with the outcome</h1><p>{copy.description}</p></div><div class="stage-track" aria-label="Setup progress"><span class="active">1</span><i></i><span>2</span><i></i><span>3</span><i></i><span>4</span></div></header>
	{#if error}<div class="creator-error"><strong>Setup unavailable</strong><p>{error}</p></div>{/if}
	<form onsubmit={submit}>
		<main class="creator-form">
			<section class="form-section"><header><span>01</span><div><h2>Coordination pattern</h2><p>This surface stays focused on one operating model.</p></div></header><div class={`fixed-type ${tone}`}><span class={`type-mark ${tone}`}>{tone === "research" ? "R" : "D"}</span><span><strong>{copy.label}</strong><small>{copy.pattern}</small></span><b>✓</b></div></section>
			<section class="form-section"><header><span>02</span><div><h2>Outcome</h2><p>Name the activity and define what its final artifact must answer.</p></div></header><div class="field-grid"><label><span>Title</span><input value={title} oninput={(event) => ontitle(event.currentTarget.value)} maxlength="120" placeholder={copy.titlePlaceholder} /></label><label><span>{copy.outcomeLabel}</span><textarea value={outcome} oninput={(event) => onoutcome(event.currentTarget.value)} maxlength="4000" placeholder={copy.outcomePlaceholder}></textarea><small>{copy.outcomeHelp}</small></label></div>{#if formError}<div class="form-error"><span>!</span><p>{formError}</p></div>{/if}</section>
		</main>
		<aside><div class="review-sticky"><span class="panel-kicker">Draft review</span><h2>{title.trim() || `Untitled ${copy.label}`}</h2><div class={`review-type ${tone}`}><i></i><span>{copy.label}</span></div><div class="review-outcome"><span>{copy.outcomeLabel}</span><p>{outcome.trim() || "The intended outcome will appear here."}</p></div><div class="next-stages"><span>Next setup stages</span><div><b>03</b><p><strong>{copy.nextTeam}</strong><small>{copy.nextTeamHelp}</small></p></div><div><b>04</b><p><strong>{copy.nextCoordination}</strong><small>{copy.nextCoordinationHelp}</small></p></div></div><button class="button primary" type="submit" disabled={loading || saving}>{saving ? "Creating…" : copy.button}</button><a class="button secondary" href={backPath}>Cancel</a></div></aside>
	</form>
</section>

<style>
	.activity-creator{margin:-5px 0 0}.creator-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:25px;margin-bottom:22px}.creator-heading h1{margin:5px 0 3px;font-size:25px;font-weight:570;letter-spacing:-.025em}.creator-heading p{margin:0;color:var(--secondary);font-size:12px}.stage-track{display:flex;align-items:center;padding-bottom:6px}.stage-track span{display:grid;width:25px;height:25px;place-items:center;background:var(--surface-1);border:1px solid var(--border);border-radius:50%;color:var(--muted);font-family:var(--font-mono);font-size:8px}.stage-track span.active{background:var(--accent-soft);border-color:rgb(208 164 92 / 30%);color:var(--accent)}.stage-track i{display:block;width:28px;height:1px;background:var(--border)}.creator-error{margin-bottom:14px;padding:12px;background:var(--danger-soft);border:1px solid rgb(216 120 114 / 20%);border-radius:7px}.creator-error strong{color:var(--danger-text);font-size:10px}.creator-error p{margin:3px 0 0;color:var(--muted);font-size:9px}.activity-creator form{display:grid;grid-template-columns:minmax(0,1fr) 310px;align-items:start;background:var(--surface-1);border:1px solid var(--border);border-radius:8px}.creator-form{min-width:0;border-right:1px solid var(--border)}.fixed-type{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;min-height:105px;padding:14px;background:rgb(118 162 206 / 5%);border:1px solid rgb(118 162 206 / 36%);border-radius:7px}.fixed-type.deliberation{background:rgb(170 139 194 / 5%);border-color:rgb(170 139 194 / 36%)}.type-mark{display:grid;width:35px;height:35px;place-items:center;background:var(--cloud-soft);border:1px solid rgb(118 162 206 / 20%);border-radius:8px;color:#95b5d4;font-size:10px;font-weight:700}.type-mark.deliberation{background:rgb(170 139 194 / 10%);border-color:rgb(170 139 194 / 20%);color:#bda3d1}.fixed-type strong,.fixed-type small{display:block}.fixed-type strong{color:var(--text);font-size:11px}.fixed-type small{margin-top:5px;color:var(--muted);font-size:9px;line-height:1.45}.fixed-type>b{display:grid;width:17px;height:17px;place-items:center;background:var(--cloud);border:1px solid var(--cloud);border-radius:50%;color:#101713;font-size:8px}.fixed-type.deliberation>b{background:var(--violet);border-color:var(--violet)}.form-section textarea{min-height:145px}.review-sticky{position:sticky;top:calc(var(--topbar-height) + 18px);padding:22px}.review-sticky h2{margin:4px 0 13px;overflow:hidden;font-size:16px;font-weight:580;text-overflow:ellipsis}.review-type{display:flex;align-items:center;gap:7px;width:max-content;padding:5px 8px;background:var(--cloud-soft);border:1px solid rgb(118 162 206 / 16%);border-radius:12px;color:#95b5d4;font-size:8px;text-transform:uppercase;letter-spacing:.06em}.review-type.deliberation{background:rgb(170 139 194 / 9%);border-color:rgb(170 139 194 / 16%);color:#bda3d1}.review-type i{width:6px;height:6px;background:var(--cloud);border-radius:50%}.review-type.deliberation i{background:var(--violet)}.review-outcome{margin:18px 0;padding:14px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.review-outcome>span,.next-stages>span{color:var(--muted);font-size:8px;font-weight:650;letter-spacing:.07em;text-transform:uppercase}.review-outcome p{max-height:110px;margin:7px 0 0;overflow:auto;color:var(--secondary);font-size:9px;line-height:1.55;white-space:pre-wrap}.next-stages{margin-bottom:19px}.next-stages>div{display:grid;grid-template-columns:25px 1fr;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)}.next-stages b{display:grid;width:21px;height:21px;place-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;color:var(--muted);font-family:var(--font-mono);font-size:7px}.next-stages p{margin:0}.next-stages strong,.next-stages small{display:block}.next-stages strong{color:var(--secondary);font-size:9px}.next-stages small{margin-top:3px;color:var(--muted);font-size:8px;line-height:1.4}.review-sticky>.button{width:100%;margin-top:8px}
	@media(max-width:900px){.activity-creator form{grid-template-columns:1fr}.creator-form{border-right:0;border-bottom:1px solid var(--border)}.review-sticky{position:static}}@media(max-width:650px){.creator-heading{align-items:flex-start;flex-direction:column}.stage-track{display:none}.form-section{padding:20px 17px}}
</style>
