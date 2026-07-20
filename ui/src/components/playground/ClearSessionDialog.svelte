<script lang="ts">
	/*
	 * Confirms replacing the current conversation with a fresh one.
	 *
	 * This owns only the store wiring and the wording; the dialog itself is the
	 * shared `ConfirmDialog`. The `reset` tone reflects that the blueprint keeps
	 * its session — only the transcript is discarded.
	 */
	import ConfirmDialog from "../shared/ConfirmDialog.svelte";
	import { clearSession, status } from "../../stores/playground";

	type Props = { onclose: () => void };

	let { onclose }: Props = $props();

	const confirm = async (): Promise<void> => {
		await clearSession();
		// Closed either way: on failure the error surfaces in the page notice.
		onclose();
	};
</script>

<ConfirmDialog
	title="Clear this session?"
	confirmLabel="Clear session"
	busyLabel="Clearing…"
	busy={$status.clearing}
	tone="reset"
	onconfirm={confirm}
	oncancel={onclose}
>
	{#snippet description()}
		The stored conversation will be deleted and replaced with a fresh session using the same blueprint.
	{/snippet}
</ConfirmDialog>
