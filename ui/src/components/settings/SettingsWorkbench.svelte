<script lang="ts">
	/*
	 * Settings shell.
	 *
	 * The page is a nav plus two cards of independently-saving sections; this
	 * component owns only that frame and the tool search box, which filters
	 * both the inventory and the configurable capabilities below it.
	 *
	 * Shared section chrome lives in `styles/settings.css` rather than here,
	 * because the sections that use it are separate components.
	 */
	import { onMount } from "svelte";

	import ErrorState from "../shared/ErrorState.svelte";
	import { tools } from "../../stores/catalog";
	import { loadSettings, setToolSearchQuery, status, toolSearchQuery } from "../../stores/settings";
	import BrokersSection from "./BrokersSection.svelte";
	import PermissionPolicySection from "./PermissionPolicySection.svelte";
	import ToolInventorySection from "./ToolInventorySection.svelte";
	import WebToolsSection from "./WebToolsSection.svelte";

	onMount(loadSettings);
</script>

<section class="settings-page">
	<header class="page-heading settings-heading">
		<div>
			<div class="eyebrow">Application</div>
			<h1>Settings</h1>
			<p>Configure installed capabilities. Brokers and tools are supplied by Nox or app extensions.</p>
		</div>
	</header>

	{#if $status.error}
		<ErrorState title="Settings unavailable" message={$status.error} onretry={loadSettings} />
	{:else}
		<div class="settings-layout">
			<nav class="settings-nav" aria-label="Settings sections">
				<span>Application settings</span>
				<a href="#brokers"><span class="settings-nav-icon">⇄</span><div><strong>Brokers</strong><small>Connections and routing</small></div></a>
				<a href="#tools"><span class="settings-nav-icon">⌘</span><div><strong>Tools</strong><small>Inventory and permissions</small></div></a>
			</nav>

			<div class="settings-content">
				<BrokersSection />

				<section id="tools" class="settings-section">
					<header>
						<div>
							<span class="panel-kicker">Runtime capabilities</span>
							<h2>Tools</h2>
							<p>Inspect registered tool sets and configure their application-wide permission policy.</p>
						</div>
						<span class="settings-count">{$status.loading ? "…" : `${$tools.length} registered`}</span>
					</header>
					<div class="capability-notice">
						<span aria-hidden="true">◇</span>
						<div>
							<strong>Extensions supply tool sets</strong>
							<p>Tool code is installed with Nox or an app extension. Blueprints decide which registered tools an agent can use.</p>
						</div>
					</div>
					<label class="tool-search">
						<span>Search tools</span>
						<div>
							<span aria-hidden="true">⌕</span>
							<input
								type="search"
								value={$toolSearchQuery}
								oninput={(event) => setToolSearchQuery(event.currentTarget.value)}
								placeholder="Search by tool, capability, or service"
							/>
						</div>
					</label>

					<ToolInventorySection />
					<WebToolsSection />
					<PermissionPolicySection />
				</section>
			</div>
		</div>
	{/if}
</section>

<style>
	.settings-heading { margin-bottom: 24px; }

	.settings-layout {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		align-items: start;
		gap: 22px;
	}
	/* -------------------------------------------------------- section nav */

	.settings-nav {
		position: sticky;
		top: calc(var(--topbar-height) + 22px);
		padding: 10px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.settings-nav > span {
		display: block;
		padding: 7px 9px 9px;
		color: var(--muted);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: .08em;
		text-transform: uppercase;
	}
	.settings-nav a {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		align-items: center;
		gap: 9px;
		padding: 9px;
		border-radius: 6px;
	}
	.settings-nav a:hover { background: var(--surface-2); }
	.settings-nav-icon {
		display: grid;
		width: 28px;
		height: 28px;
		place-items: center;
		background: #1b211c;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 11px;
	}
	.settings-nav strong,
	.settings-nav small { display: block; }
	.settings-nav strong {
		font-size: 11px;
		font-weight: 590;
	}
	.settings-nav small {
		margin-top: 1px;
		color: var(--muted);
		font-size: 8px;
	}

	/* ------------------------------------------------------------ search */

	.tool-search {
		display: block;
		margin: 0 20px 18px;
	}
	.tool-search > span {
		display: block;
		margin-bottom: 6px;
		color: var(--secondary);
		font-size: 9px;
		font-weight: 540;
	}
	.tool-search > div { position: relative; }
	.tool-search > div > span {
		position: absolute;
		top: 50%;
		left: 11px;
		color: var(--muted);
		font-size: 13px;
		transform: translateY(-50%);
		pointer-events: none;
	}
	.tool-search input {
		width: 100%;
		height: 38px;
		padding: 0 12px 0 34px;
		background: var(--field-bg);
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		color: var(--text);
		outline: 0;
		font-size: 10px;
	}
	.tool-search input:focus {
		border-color: var(--field-border-focus);
		box-shadow: 0 0 0 2px rgb(208 164 92 / 7%);
	}
	/* -------------------------------------------------------- breakpoints */

	@media (max-width: 1120px) {
		.settings-layout { grid-template-columns: 180px minmax(0, 1fr); }
	}

	@media (max-width: 900px) {
		.settings-layout { grid-template-columns: 1fr; }
		/* Nav becomes a horizontal scroller above the content. */
		.settings-nav {
			position: static;
			display: flex;
			gap: 4px;
			overflow-x: auto;
		}
		.settings-nav > span { display: none; }
		.settings-nav a { min-width: 190px; }
	}
</style>
