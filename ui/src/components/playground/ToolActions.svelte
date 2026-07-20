<script lang="ts">
	import { actionState } from "../../utils/conversation";
	import { formatMessageTime } from "../../utils/format";
	import { responseText } from "../../utils/messages";

	import type { ToolAction } from "../../utils/conversation";

	type Props = { actions: ToolAction[] };

	let { actions }: Props = $props();

	const hasFailed = (action: ToolAction): boolean => action.responses.some((response) => response.isError);

	/** Failed, returned, or still in flight. */
	const iconFor = (action: ToolAction): string => {
		if (hasFailed(action)) return "!";
		return action.responses.length ? "✓" : "⌘";
	};

	const resultLabel = (execution: ToolAction["responses"][number]["execution"]): string => {
		if (execution === "deferredAck") return "Accepted";
		if (execution === "deferredResult") return "Deferred result";
		return "Result";
	};
</script>

<section class="tool-actions" aria-label="Agent actions">
	<header><span>{actions.length === 1 ? "Action" : "Actions"}</span><strong>{actions.length}</strong></header>
	<ul>
		{#each actions as action (action.trackId)}
			<li>
				<details class="tool-action" class:error={hasFailed(action)}>
					<summary>
						<span class="tool-action-icon">{iconFor(action)}</span>
						<strong>{action.name}</strong>
						<small>{actionState(action)}</small>
						<span class="tool-action-chevron">›</span>
					</summary>
					<div class="tool-action-detail">
						{#if action.call}
							<section>
								<span>Input</span>
								<pre>{JSON.stringify(action.call.arguments, null, 2)}</pre>
							</section>
						{/if}
						{#each action.responses as response}
							<section>
								<span>{resultLabel(response.execution)}</span>
								<pre>{responseText(response) || "No textual output"}</pre>
							</section>
						{/each}
						<footer class="message-footer">{formatMessageTime(action.time)}</footer>
					</div>
				</details>
			</li>
		{/each}
	</ul>
</section>

<style>
	.tool-actions {
		margin: 10px 0 14px;
		background: #101512;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.tool-actions > header {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 7px 10px;
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: .08em;
	}
	.tool-actions > header strong {
		display: grid;
		min-width: 16px;
		height: 16px;
		place-items: center;
		background: var(--surface-2);
		border-radius: 8px;
		color: var(--secondary);
		font-size: 8px;
	}
	.tool-actions ul { margin: 0; padding: 0; list-style: none; }
	/* Divider between batched actions; the block border handles the outside. */
	.tool-actions li + li { border-top: 1px solid var(--border); }
	/* Collapsed by default: the name and outcome are the summary, the payloads
	   open on demand. */
	.tool-action > summary {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) auto 12px;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		padding: 5px 9px;
		cursor: pointer;
		list-style: none;
	}
	.tool-action > summary::-webkit-details-marker { display: none; }
	.tool-action > summary:hover { background: var(--surface-hover); }
	.tool-action-icon {
		display: grid;
		width: 21px;
		height: 21px;
		place-items: center;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 14%);
		border-radius: 5px;
		color: var(--healthy);
		font-size: 8px;
	}
	.tool-action.error .tool-action-icon {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 17%);
		color: var(--danger);
	}
	.tool-action summary strong {
		overflow: hidden;
		color: var(--text);
		font-size: 9px;
		font-weight: 570;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool-action summary small {
		color: var(--muted);
		font-size: 8px;
	}
	.tool-action-chevron {
		color: var(--muted);
		font-family: var(--font-mono);
		transition: transform 120ms ease;
	}
	.tool-action[open] .tool-action-chevron { transform: rotate(90deg); }
	/* Indented to line up with the summary text, past the icon. */
	.tool-action-detail {
		padding: 0 10px 9px 39px;
		border-top: 1px solid rgb(154 167 158 / 8%);
	}
	.tool-action-detail section { padding-top: 8px; }
	.tool-action-detail section > span {
		color: var(--muted);
		font-size: 7px;
		text-transform: uppercase;
		letter-spacing: .07em;
	}
	.tool-action-detail pre {
		max-height: 130px;
		margin: 7px 0 0;
		padding: 7px;
		overflow: auto;
		background: var(--code-bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 1.45;
		white-space: pre-wrap;
	}
	.message-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		margin-top: 8px;
		padding-top: 6px;
		border-top: 1px solid rgb(154 167 158 / 10%);
		color: var(--muted);
		font-family: var(--font-mono-explicit);
		font-size: 7px;
		font-style: normal;
		letter-spacing: .015em;
		line-height: 1.2;
	}
</style>
