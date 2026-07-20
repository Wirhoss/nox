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
			<div><span>Blueprints</span><strong>{loading ? '—' : snapshot.blueprints.length}</strong></div><span class="metric-note">Agent definitions</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon blue"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 2v4M16 2v4M6 6h12v5a6 6 0 0 1-12 0ZM12 17v5" /></svg></div>
			<div><span>Providers</span><strong>{loading ? '—' : providerCount}</strong></div><span class="metric-note">Configured backends</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon green"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-3-3Z" /></svg></div>
			<div><span>Tool sets</span><strong>{loading ? '—' : snapshot.tools.length}</strong></div><span class="metric-note">Runtime capabilities</span>
		</div>
		<div class="metric-card">
			<div class="metric-icon violet"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3v-7a4 4 0 0 1-1-2.65V7a4 4 0 0 1 4-4h11a4 4 0 0 1 4 4Z" /></svg></div>
			<div><span>Sessions</span><strong>{loading ? '—' : snapshot.sessions.length}</strong></div><span class="metric-note">Stored locally</span>
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
				<div class="provider-list">{#each snapshot.providers as provider}<div class="provider-row"><div class="provider-logo">{provider.id.slice(0, 2).toUpperCase()}</div><div><strong>{provider.id}</strong><span>{provider.type.replaceAll('_', ' ')}</span></div><span class:inactive={provider.status === 'inactive'} class="origin-badge cloud">{provider.status}</span></div>{/each}</div>
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
