<script lang="ts">
	/*
	 * The broker inventory.
	 *
	 * Read-only: brokers are code, installed with Nox or an extension, not
	 * configuration a user creates. Only the built-in Web broker exists today,
	 * so this section exists mainly to say where new ones would appear.
	 */
</script>

<section id="brokers" class="settings-section">
	<header><div><span class="panel-kicker">Runtime connections</span><h2>Brokers</h2><p>Configure brokers already supplied by Nox or an installed extension.</p></div><span class="settings-count">1 available</span></header>
	<div class="capability-notice"><span aria-hidden="true">◇</span><div><strong>Extensions supply broker types</strong><p>New broker implementations are installed as app extensions. They are not created from this workbench.</p></div></div>
	<div class="capability-list">
		<div class="capability-row">
			<div class="capability-mark web">W</div>
			<div class="capability-copy"><strong>Web</strong><span>Built into Nox · Playground and local sessions</span></div>
			<span class="capability-origin">BUILT-IN</span><span class="capability-status"><i></i> Available</span>
		</div>
	</div>
	<div class="settings-footnote"><strong>No broker settings exposed</strong><p>The built-in Web broker uses the blueprint selected when a session starts. Extension-provided settings will appear in this section.</p></div>
</section>

<style>
	.settings-footnote {
		margin: 0 20px 20px;
		padding: 12px;
		background: var(--surface-sunken);
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.settings-footnote strong {
		color: var(--secondary);
		font-size: 9px;
		font-weight: 580;
	}
	.settings-footnote p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 8px;
	}
</style>
