<script lang="ts">
	import { onMount } from 'svelte';
	import Avatar from '../shared/Avatar.svelte';

	type Blueprint = { id: string; description: string };
	type Session = { sessionId: string; blueprintId: string; createdAt: string | number; updatedAt: string | number };
	type Provider = { id: string; type: string; status: 'active' | 'inactive'; baseUrl?: string; hasApiKey?: boolean };
	type Snapshot = {
		blueprints: Blueprint[];
		providers: Provider[];
		sessions: Session[];
		tools: string[];
	};

	let loading = true;
	let refreshing = false;
	let daemonOnline = false;
	let errorMessage = '';
	let lastUpdated: Date | null = null;
	let snapshot: Snapshot = { blueprints: [], providers: [], sessions: [], tools: [] };

	async function apiGet<T>(path: string): Promise<T> {
		const response = await fetch(path, { headers: { accept: 'application/json' } });
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return response.json() as Promise<T>;
	}

	const refresh = async () => {
		refreshing = !loading;
		errorMessage = '';
		try {
			await apiGet<{ status: string }>('/api/health/live');
			daemonOnline = true;
		} catch {
			daemonOnline = false;
			errorMessage = 'The Nox daemon could not be reached.';
			loading = false;
			refreshing = false;
			return;
		}

		const [blueprints, providers, sessions, tools] = await Promise.allSettled([
			apiGet<Blueprint[]>('/api/v1/blueprints'),
			apiGet<Provider[]>('/api/v1/providers'),
			apiGet<Session[]>('/api/v1/sessions'),
			apiGet<string[]>('/api/v1/tools'),
		]);

		snapshot = {
			blueprints: blueprints.status === 'fulfilled' ? blueprints.value : [],
			providers: providers.status === 'fulfilled' ? providers.value : [],
			sessions: sessions.status === 'fulfilled' ? sessions.value : [],
			tools: tools.status === 'fulfilled' ? tools.value : [],
		};
		const failures = [blueprints, providers, sessions, tools].filter((result) => result.status === 'rejected').length;
		if (failures) errorMessage = `${failures} workbench ${failures === 1 ? 'resource is' : 'resources are'} temporarily unavailable.`;
		lastUpdated = new Date();
		loading = false;
		refreshing = false;
	};

	const formatRelativeTime = (value: string | number) => {
		const raw = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
		const date = new Date(raw);
		if (Number.isNaN(date.getTime())) return 'Unknown';
		const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
		if (seconds < 60) return 'Just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	};

	const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
	$: providerCount = snapshot.providers.length;
	$: recentSessions = [...snapshot.sessions]
		.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
		.slice(0, 4);
	$: setupComplete = providerCount > 0 && snapshot.blueprints.length > 0;

	onMount(refresh);
</script>

<svelte:head><meta name="color-scheme" content="dark" /></svelte:head>

<section class="overview-page">
	<header class="page-heading">
		<div>
			<div class="eyebrow">Control plane</div>
			<h1>Overview</h1>
			<p>Configure and observe the parts of Nox that are available today.</p>
		</div>
		<div class="page-actions">
			{#if lastUpdated}<span class="last-updated">Updated {formatRelativeTime(lastUpdated.getTime())}</span>{/if}
			<button class="button secondary" type="button" onclick={refresh} disabled={loading || refreshing}>
				<svg class:spinning={refreshing} aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
				{refreshing ? 'Refreshing' : 'Refresh'}
			</button>
		</div>
	</header>

	{#if loading}
		<div class="system-strip skeleton-strip" aria-label="Loading system status"><div class="skeleton-line wide"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
	{:else}
		<div class:offline={!daemonOnline} class="system-strip">
			<div class="system-primary">
				<span class:healthy={daemonOnline} class="status-orb"></span>
				<div><strong>{daemonOnline ? 'Nox is available' : 'Nox daemon is offline'}</strong><span>{daemonOnline ? 'API responding from the local workbench' : 'Start the daemon to load workbench data'}</span></div>
			</div>
			{#if daemonOnline}
				<div class="system-facts"><span><strong>{snapshot.blueprints.length}</strong> blueprints</span><span><strong>{providerCount}</strong> providers</span><span><strong>{snapshot.sessions.length}</strong> saved sessions</span></div>
			{:else}
				<button class="button danger-quiet" type="button" onclick={refresh}>Try again</button>
			{/if}
		</div>
	{/if}

	{#if errorMessage && daemonOnline}<div class="inline-notice" role="status"><span>!</span>{errorMessage}</div>{/if}

	<div class="metric-grid" aria-label="Workbench inventory">
		<div class="metric-card">
			<div class="metric-icon amber"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 14v6M14 17h6" /></svg></div>
			<div class="metric-value"><span>Blueprints</span><strong>{loading ? '—' : snapshot.blueprints.length}</strong></div><span class="metric-note">Agent definitions</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon blue"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 2v4M16 2v4M6 6h12v5a6 6 0 0 1-12 0ZM12 17v5" /></svg></div>
			<div class="metric-value"><span>Providers</span><strong>{loading ? '—' : providerCount}</strong></div><span class="metric-note">Configured backends</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon green"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-3-3Z" /></svg></div>
			<div class="metric-value"><span>Tool sets</span><strong>{loading ? '—' : snapshot.tools.length}</strong></div><span class="metric-note">Runtime capabilities</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon violet"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3v-7a4 4 0 0 1-1-2.65V7a4 4 0 0 1 4-4h11a4 4 0 0 1 4 4Z" /></svg></div>
			<div class="metric-value"><span>Sessions</span><strong>{loading ? '—' : snapshot.sessions.length}</strong></div><span class="metric-note">Stored locally</span>
		</div>
	</div>

	<div class="overview-grid">
		<section class="panel setup-panel">
			<header class="panel-heading"><div><span class="panel-kicker">Workbench</span><h2>{setupComplete ? 'Ready for the next step' : 'Finish local setup'}</h2></div><span class:complete={setupComplete} class="setup-count">{setupComplete ? '2/2 ready' : `${Number(providerCount > 0) + Number(snapshot.blueprints.length > 0)}/2 ready`}</span></header>
			<div class="setup-list">
				<div class:done={providerCount > 0} class="setup-item"><div class="setup-check">{providerCount > 0 ? '✓' : '1'}</div><div><strong>Configure a provider</strong><span>{providerCount > 0 ? `${providerCount} ${providerCount === 1 ? 'provider is' : 'providers are'} configured` : 'Connect a local or cloud model backend'}</span></div><span class="setup-state">{providerCount > 0 ? 'Ready' : 'Required'}</span></div>
				<div class:done={snapshot.blueprints.length > 0} class="setup-item"><div class="setup-check">{snapshot.blueprints.length > 0 ? '✓' : '2'}</div><div><strong>Create a blueprint</strong><span>{snapshot.blueprints.length > 0 ? `${snapshot.blueprints.length} agent ${snapshot.blueprints.length === 1 ? 'definition' : 'definitions'} available` : 'Define instructions, tools, provider, and model'}</span></div><span class="setup-state">{snapshot.blueprints.length > 0 ? 'Ready' : 'Required'}</span></div>
				<a class="setup-item setup-link" href="/playground"><div class="setup-check">3</div><div><strong>Test in Playground</strong><span>Start a session and inspect model, tool, and permission events</span></div><span class="setup-state">Open →</span></a>
			</div>
		</section>

		<section class="panel sessions-panel">
			<header class="panel-heading"><div><span class="panel-kicker">Local history</span><h2>Recent sessions</h2></div>{#if snapshot.sessions.length > 4}<span class="subtle-count">{snapshot.sessions.length} total</span>{/if}</header>
			{#if loading}
				<div class="session-list loading-list">{#each [1, 2, 3] as _}<div class="session-row"><div class="skeleton-avatar"></div><div class="skeleton-copy"><span></span><span></span></div></div>{/each}</div>
			{:else if recentSessions.length > 0}
				<div class="session-list">{#each recentSessions as session}<a class="session-row" href={`/playground?session=${encodeURIComponent(session.sessionId)}`}><Avatar kind="blueprint" seed={`blueprint:${session.blueprintId}`} label={session.blueprintId} size={29} /><div class="session-copy"><strong>{session.blueprintId}</strong><span><code>{shortId(session.sessionId)}</code> · {formatRelativeTime(session.updatedAt)}</span></div><span class="origin-badge">WEB</span></a>{/each}</div>
			{:else}
				<div class="empty-state compact"><div class="empty-mark"><span></span><span></span><span></span></div><strong>No sessions yet</strong><p>Your locally stored conversations will appear here.</p></div>
			{/if}
		</section>

		<section class="panel providers-panel">
			<header class="panel-heading"><div><span class="panel-kicker">Execution</span><h2>Provider inventory</h2></div></header>
			{#if !loading && providerCount > 0}
				<div class="provider-list">{#each snapshot.providers as provider}<div class="provider-row"><div class="provider-logo">{provider.id.slice(0, 2).toUpperCase()}</div><div class="provider-copy"><strong>{provider.id}</strong><span>{provider.type.replaceAll('_', ' ')}</span></div><span class:inactive={provider.status === 'inactive'} class="origin-badge cloud">{provider.status}</span></div>{/each}</div>
			{:else if !loading}
				<div class="empty-state compact"><div class="empty-provider">+</div><strong>No provider configured</strong><p>Add a model backend before creating runnable sessions.</p></div>
			{/if}
		</section>

		<section class="panel telemetry-panel">
			<header class="panel-heading"><div><span class="panel-kicker">Observability</span><h2>Resource telemetry</h2></div><span class="planned-badge">PLANNED</span></header>
			<div class="telemetry-preview" aria-hidden="true"><div class="telemetry-axis"><span></span><span></span><span></span></div><div class="telemetry-bars"><span style="height: 29%"></span><span style="height: 47%"></span><span style="height: 38%"></span><span style="height: 70%"></span><span style="height: 54%"></span><span style="height: 82%"></span><span style="height: 63%"></span><span style="height: 74%"></span></div></div>
			<div class="telemetry-note"><strong>No usage contract yet</strong><p>Token usage, context avoided, latency, and cloud cost will appear when the backend exposes measured data.</p></div>
		</section>
	</div>
</section>

<style>
	/* ------------------------------------------------------- system strip */

	.system-strip {
		display: flex;
		min-height: 70px;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding: 13px 16px;
		background: linear-gradient(110deg, #141c16, var(--surface-raised));
		border: 1px solid #27372c;
		border-radius: 8px;
	}
	.system-strip.offline {
		background: linear-gradient(110deg, #1c1413, #151211);
		border-color: #3b2523;
	}
	.system-primary {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.system-primary strong,
	.system-primary span { display: block; }
	.system-primary strong {
		font-size: 13px;
		font-weight: 620;
	}
	.system-primary span:not(.status-orb) {
		margin-top: 2px;
		color: var(--muted);
		font-size: 11px;
	}
	.status-orb {
		width: 9px;
		height: 9px;
		background: var(--danger);
		border-radius: 50%;
		box-shadow: 0 0 0 5px rgb(216 120 114 / 8%);
	}
	.status-orb.healthy {
		background: var(--healthy);
		box-shadow: 0 0 0 5px rgb(105 180 134 / 9%);
	}
	.system-facts {
		display: flex;
		align-items: center;
		color: var(--muted);
		font-size: 11px;
	}
	.system-facts span {
		padding: 0 16px;
		border-left: 1px solid var(--border);
	}
	.system-facts strong {
		margin-right: 3px;
		color: var(--text);
		font-family: var(--font-mono-explicit);
		font-size: 12px;
		font-weight: 550;
	}

	.inline-notice {
		display: flex;
		align-items: center;
		gap: 9px;
		margin-top: 10px;
		padding: 8px 12px;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 15%);
		border-radius: 6px;
		color: #c9b184;
		font-size: 11px;
	}
	.inline-notice > span {
		display: grid;
		width: 17px;
		height: 17px;
		place-items: center;
		border: 1px solid rgb(208 164 92 / 35%);
		border-radius: 50%;
		font-size: 10px;
		font-weight: 700;
	}

	/* ------------------------------------------------------- metric cards */

	.metric-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
		margin-top: 12px;
	}
	/* Icon spans both rows on the left; value and note stack on the right. */
	.metric-card {
		display: grid;
		grid-template-columns: 38px 1fr;
		grid-template-rows: auto auto;
		column-gap: 11px;
		min-height: 86px;
		align-items: center;
		padding: 13px 14px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.metric-value {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.metric-value span {
		color: var(--secondary);
		font-size: 12px;
	}
	.metric-value strong {
		font-family: var(--font-mono-explicit);
		font-size: 21px;
		font-weight: 520;
		letter-spacing: -.04em;
	}
	.metric-note {
		align-self: start;
		color: var(--muted);
		font-size: 10px;
	}
	.metric-icon {
		grid-row: 1 / 3;
		display: grid;
		width: 36px;
		height: 36px;
		place-items: center;
		border: 1px solid;
		border-radius: 7px;
	}
	.metric-icon svg {
		width: 17px;
		height: 17px;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.6;
	}
	.metric-icon.amber {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 15%);
		color: var(--accent);
	}
	.metric-icon.blue {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 15%);
		color: var(--cloud);
	}
	.metric-icon.green {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 15%);
		color: var(--healthy);
	}
	.metric-icon.violet {
		background: #251d2b;
		border-color: rgb(170 139 194 / 15%);
		color: var(--violet);
	}

	/* ------------------------------------------------------------- panels */

	.overview-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr);
		gap: 12px;
		margin-top: 12px;
	}
	.panel {
		min-width: 0;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.panel-heading {
		display: flex;
		min-height: 67px;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 13px 16px;
		border-bottom: 1px solid var(--border);
	}
	.panel-heading h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 590;
		letter-spacing: -.01em;
	}

	.setup-count,
	.subtle-count,
	.planned-badge {
		padding: 3px 7px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--muted);
		font-family: var(--font-mono-explicit);
		font-size: 9px;
	}
	.setup-count.complete {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 15%);
		color: var(--healthy);
	}

	.setup-list,
	.session-list,
	.provider-list { padding: 6px 16px 9px; }

	/* --------------------------------------------------------- setup list */

	.setup-item {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr) auto;
		min-height: 61px;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--border);
	}
	.setup-item:last-child,
	.session-row:last-child,
	.provider-row:last-child { border-bottom: 0; }
	.setup-link { transition: background 120ms ease; }
	.setup-link:hover { background: rgb(255 255 255 / 1.5%); }
	.setup-link:hover .setup-state { color: var(--accent); }
	.setup-check {
		display: grid;
		width: 26px;
		height: 26px;
		place-items: center;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.setup-item.done .setup-check {
		background: var(--healthy-soft);
		border-color: rgb(105 180 134 / 20%);
		color: var(--healthy);
	}
	.setup-item strong,
	.setup-item span:not(.setup-state) { display: block; }
	.setup-item strong {
		font-size: 12px;
		font-weight: 560;
	}
	.setup-item div > span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 10px;
	}
	.setup-state {
		color: var(--muted);
		font-size: 10px;
	}
	.setup-item.done .setup-state { color: var(--healthy); }

	/* ----------------------------------------------- session/provider rows */

	.session-row,
	.provider-row {
		display: flex;
		min-height: 55px;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--border);
	}
	.provider-logo {
		display: grid;
		width: 29px;
		height: 29px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--mark-bg);
		border: 1px solid var(--mark-border);
		border-radius: 6px;
		color: #c7cec9;
		font-size: 10px;
		font-weight: 650;
	}
	.session-copy,
	.provider-copy {
		min-width: 0;
		flex: 1;
	}
	.session-copy strong,
	.session-copy span,
	.provider-copy strong,
	.provider-copy span { display: block; }
	.session-copy strong,
	.provider-copy strong {
		overflow: hidden;
		font-size: 11px;
		font-weight: 570;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.session-copy span,
	.provider-copy span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 10px;
		text-transform: capitalize;
	}
	.session-copy code {
		font-family: var(--font-mono);
		font-size: 9px;
	}

	.origin-badge,
	.planned-badge {
		flex: 0 0 auto;
		padding: 2px 6px;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 13%);
		border-radius: 4px;
		color: #80b693;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: .04em;
	}
	.origin-badge.cloud {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 14%);
		color: #8aafd2;
	}
	.origin-badge.inactive {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 14%);
		color: #d9908b;
	}
	.planned-badge {
		background: var(--surface-2);
		border-color: var(--border);
		color: var(--muted);
	}

	/* -------------------------------------------------------- empty states */

	.empty-state {
		display: flex;
		min-height: 170px;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 20px;
		text-align: center;
	}
	.empty-state strong {
		margin-top: 10px;
		font-size: 12px;
		font-weight: 570;
	}
	.empty-state p {
		max-width: 240px;
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 10px;
	}
	.empty-mark {
		display: flex;
		gap: 4px;
		padding: 8px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.empty-mark span {
		width: 4px;
		height: 4px;
		background: var(--muted);
		border-radius: 50%;
	}
	.empty-provider {
		display: grid;
		width: 32px;
		height: 32px;
		place-items: center;
		background: var(--surface-2);
		border: 1px dashed var(--border-strong);
		border-radius: 7px;
		color: var(--muted);
	}

	/* ---------------------------------------------------------- telemetry */

	/* Static preview only — there is no measured data behind these bars yet. */
	.telemetry-preview {
		position: relative;
		height: 105px;
		margin: 15px 16px 0;
		overflow: hidden;
		opacity: .45;
	}
	.telemetry-axis {
		position: absolute;
		inset: 0;
		display: flex;
		justify-content: space-between;
		flex-direction: column;
	}
	.telemetry-axis span {
		width: 100%;
		border-top: 1px dashed var(--border-strong);
	}
	.telemetry-bars {
		position: absolute;
		inset: 0 5px;
		display: flex;
		align-items: flex-end;
		gap: 6px;
	}
	.telemetry-bars span {
		flex: 1;
		background: linear-gradient(to top, #4b4230, var(--accent));
		border-radius: 2px 2px 0 0;
	}
	.telemetry-note {
		padding: 11px 16px 15px;
		border-top: 1px solid var(--border);
	}
	.telemetry-note strong {
		font-size: 11px;
		font-weight: 560;
	}
	.telemetry-note p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 10px;
	}

	/* ---------------------------------------------------------- skeletons */

	.skeleton-strip,
	.skeleton-line,
	.skeleton-avatar,
	.skeleton-copy span {
		background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.35s infinite linear;
	}
	.skeleton-strip { flex-direction: row; }
	.skeleton-line {
		width: 100px;
		height: 10px;
		border-radius: 4px;
	}
	.skeleton-line.wide { width: 240px; }
	.skeleton-avatar {
		width: 29px;
		height: 29px;
		border-radius: 6px;
	}
	.skeleton-copy {
		display: flex;
		flex: 1;
		gap: 7px;
		flex-direction: column;
	}
	.skeleton-copy span {
		width: 60%;
		height: 8px;
		border-radius: 3px;
	}
	.skeleton-copy span:last-child {
		width: 35%;
		height: 6px;
	}

	/* -------------------------------------------------------- breakpoints */

	@media (max-width: 1120px) {
		.metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.overview-grid { grid-template-columns: 1fr; }
	}

	@media (max-width: 620px) {
		.metric-grid { grid-template-columns: 1fr; }
		.metric-card { min-height: 75px; }
		.system-strip {
			align-items: flex-start;
			flex-direction: column;
		}
		.system-facts { width: 100%; }
		.system-facts span {
			flex: 1;
			padding: 0 8px;
			text-align: center;
		}
		.system-facts span:first-child {
			padding-left: 0;
			border-left: 0;
		}
		/* Drop the trailing state column; the check mark already conveys it. */
		.setup-item {
			grid-template-columns: 30px minmax(0, 1fr);
			padding: 7px 0;
		}
		.setup-state { display: none; }
	}
</style>
