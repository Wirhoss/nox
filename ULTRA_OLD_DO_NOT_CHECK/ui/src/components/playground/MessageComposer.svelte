<script lang="ts">
	import { currentSession, run, selectedBlueprint, sendMessage, status } from "../../stores/playground";

	let prompt = $state("");

	const canSend = $derived(Boolean($currentSession) && prompt.trim().length > 0 && !$status.sending);

	const submit = (): void => {
		if (!canSend) return;
		const text = prompt;
		// Cleared up front so the field is ready for the next message while the
		// request is still in flight; the store restores nothing on failure.
		prompt = "";
		void sendMessage(text);
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	};
</script>

<div class="composer-wrap">
	<label class="composer" class:disabled={!$currentSession}>
		<span class="visually-hidden">Message {$selectedBlueprint?.id ?? "blueprint"}</span>
		<textarea
			bind:value={prompt}
			disabled={!$currentSession || $status.sending}
			rows="2"
			placeholder={$currentSession ? `Message ${$selectedBlueprint?.id}…` : "Start a session to send a message"}
			onkeydown={onKeydown}
		></textarea>
		<div class="composer-footer">
			<span>{$run.active ? "A run is active" : "Enter to send · Shift+Enter for a new line"}</span>
			<button type="button" onclick={submit} disabled={!canSend}>
				<span aria-hidden="true">↑</span>{$status.sending ? "Queued" : "Send"}
			</button>
		</div>
	</label>
</div>

<style>
	/* Gradient fades the transcript out behind the composer as it scrolls. */
	.composer-wrap {
		padding: 10px 16px 14px;
		background: linear-gradient(to top, var(--canvas) 80%, rgb(12 15 13 / 0%));
	}
	/* The label is the input surface; the textarea inside is chromeless so the
	   focus ring can be drawn once, around the whole block. */
	.composer {
		display: block;
		width: min(760px, 100%);
		margin: 0 auto;
		overflow: hidden;
		background: var(--surface-raised);
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		box-shadow: 0 10px 35px rgb(0 0 0 / 16%);
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}
	.composer:focus-within {
		border-color: #61563f;
		box-shadow: 0 0 0 2px rgb(208 164 92 / 7%), 0 10px 35px rgb(0 0 0 / 16%);
	}
	.composer.disabled { opacity: .55; }
	.composer textarea {
		display: block;
		width: 100%;
		min-height: 58px;
		max-height: 170px;
		padding: 11px 12px 4px;
		resize: none;
		background: transparent;
		border: 0;
		outline: 0;
		color: var(--text);
		font-size: 11px;
		line-height: 1.5;
	}
	.composer textarea::placeholder { color: #626c65; }
	.composer-footer {
		display: flex;
		min-height: 39px;
		align-items: center;
		justify-content: space-between;
		padding: 4px 6px 6px 12px;
	}
	.composer-footer > span {
		color: var(--muted);
		font-size: 8px;
	}
	.composer-footer button {
		display: flex;
		height: 29px;
		align-items: center;
		gap: 5px;
		padding: 0 10px;
		background: var(--accent);
		border: 1px solid var(--accent-border);
		border-radius: 5px;
		color: var(--on-accent);
		cursor: pointer;
		font-size: 9px;
		font-weight: 650;
	}
	.composer-footer button > span {
		display: grid;
		width: 15px;
		height: 15px;
		place-items: center;
		background: rgb(0 0 0 / 11%);
		border-radius: 4px;
		font-size: 11px;
	}
	.composer-footer button:disabled {
		cursor: default;
		opacity: .45;
	}

	@media (max-width: 620px) {
		.composer-wrap { padding: 8px 10px 11px; }
	}
</style>
