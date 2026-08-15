<script lang="ts">
	import { conversationItems, runStartedAt, selectedBlueprint, stream } from "../../stores/playground";
	import { agentTime, buildAgentBlocks } from "../../utils/conversation";
	import { textContent } from "../../utils/messages";
	import Markdown from "../shared/Markdown.svelte";
	import ChatMessage from "./ChatMessage.svelte";
	import MessageContent from "./MessageContent.svelte";
	import ReasoningBlock from "./ReasoningBlock.svelte";
	import ToolActions from "./ToolActions.svelte";

	const blueprintId = $derived($selectedBlueprint?.id ?? "unknown");
</script>

<div class="message-stack">
	{#each $conversationItems as item}
		{#if item.kind === "user"}
			{@const message = item.entry.message}
			{#if message.role === "user"}
				<ChatMessage role="user" {blueprintId} time={item.entry.time}>
					<MessageContent {message} />
				</ChatMessage>
			{/if}
		{:else}
			<!-- One agent turn: reasoning, tool actions and prose, in order. -->
			{@const blocks = buildAgentBlocks(item.entries)}
			<ChatMessage
				role="assistant"
				{blueprintId}
				streaming={item.live}
				time={agentTime(item.entries, $runStartedAt)}
			>
				{#each blocks as block}
					{#if block.kind === "reasoning" && block.entry.message.role === "reasoning"}
						<ReasoningBlock source={textContent(block.entry.message)} hint="Show" />
					{:else if block.kind === "tools"}
						<ToolActions actions={block.actions} />
					{:else if block.kind === "assistant" && block.entry.message.role === "assistant"}
						<MessageContent message={block.entry.message} />
					{/if}
				{/each}

				<!-- Fragments that have not settled into messages yet. -->
				{#if item.live && $stream.reasoning}
					<ReasoningBlock
						source={$stream.reasoning}
						live
						open={!$stream.reasoningCollapsed}
						hint={$stream.reasoningCollapsed ? "Show" : "Thinking…"}
					/>
				{/if}
				{#if item.live && $stream.text}
					<Markdown source={$stream.text} />
					<span class="stream-caret"></span>
				{/if}
			</ChatMessage>
		{/if}
	{/each}
</div>

<style>
	.message-stack {
		width: min(760px, 100%);
		margin: 0 auto;
		padding: 30px 28px 22px;
	}
	/* Blinking block cursor trailing the last streamed token. */
	.stream-caret {
		display: inline-block;
		width: 5px;
		height: 12px;
		margin-left: 3px;
		background: var(--accent);
		vertical-align: -2px;
		animation: status-pulse .8s steps(1) infinite;
	}

	@media (max-width: 620px) {
		.message-stack { padding: 24px 14px 18px; }
	}
</style>
