<script lang="ts">
	/*
	 * Modal confirmation for a destructive action.
	 *
	 * Five near-identical copies of this existed — one per resource that can be
	 * deleted, plus the Playground's clear-session variant. They differed only
	 * in wording and in which busy flag they read, both of which are props here.
	 *
	 * The dialog is uncontrolled: the caller mounts it to open it and unmounts
	 * it in `oncancel`. While `busy` is set, dismissal is refused so a request
	 * in flight cannot be orphaned.
	 */
	import { onMount } from "svelte";

	import type { Snippet } from "svelte";

	type Props = {
		/** Set while the confirmed action runs; blocks dismissal and re-entry. */
		busy?: boolean;
		busyLabel?: string;
		confirmLabel: string;
		/** Body copy. A snippet, because these often embed an id or a count. */
		description: Snippet;
		oncancel: () => void;
		onconfirm: () => void;
		title: string;
		/**
		 * `danger` for an irreversible delete, `reset` for an action that
		 * discards state but leaves the resource in place.
		 */
		tone?: "danger" | "reset";
	};

	let {
		busy = false,
		busyLabel = "Working…",
		confirmLabel,
		description,
		oncancel,
		onconfirm,
		title,
		tone = "danger",
	}: Props = $props();

	const titleId = $props.id();
	const descriptionId = `${titleId}-description`;
	let dialogElement: HTMLDivElement;
	let cancelButton: HTMLButtonElement;

	const focusableSelector = [
		'a[href]',
		'button:not([disabled])',
		'input:not([disabled])',
		'select:not([disabled])',
		'textarea:not([disabled])',
		'[tabindex]:not([tabindex="-1"])',
	].join(',');

	const focusableElements = (): HTMLElement[] =>
		[...dialogElement.querySelectorAll<HTMLElement>(focusableSelector)]
			.filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

	const dismiss = (): void => {
		if (!busy) oncancel();
	};

	const handleKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			dismiss();
			return;
		}
		if (event.key !== "Tab") return;

		const elements = focusableElements();
		if (elements.length === 0) {
			event.preventDefault();
			dialogElement.focus();
			return;
		}

		const first = elements[0]!;
		const last = elements.at(-1)!;
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialogElement.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !dialogElement.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	};

	onMount(() => {
		const previouslyFocused = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		cancelButton.focus();

		return () => {
			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="dialog-backdrop"
	role="presentation"
	onclick={(event) => { if (event.target === event.currentTarget) dismiss(); }}
>
	<div
		bind:this={dialogElement}
		class="confirm-dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
		aria-describedby={descriptionId}
		tabindex="-1"
	>
		<div class="dialog-danger-mark" class:reset-mark={tone === "reset"}>{tone === "reset" ? "↻" : "×"}</div>
		<h2 id={titleId}>{title}</h2>
		<p id={descriptionId}>{@render description()}</p>
		<div class="dialog-actions">
			<button bind:this={cancelButton} class="button secondary" type="button" onclick={oncancel} disabled={busy}>Cancel</button>
			<button class="button danger" type="button" onclick={onconfirm} disabled={busy}>
				{busy ? busyLabel : confirmLabel}
			</button>
		</div>
	</div>
</div>

<style>
	/* Amber variant of the shared dialog mark, for a non-destructive reset. */
	.reset-mark {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 20%);
		color: var(--accent);
	}
</style>
