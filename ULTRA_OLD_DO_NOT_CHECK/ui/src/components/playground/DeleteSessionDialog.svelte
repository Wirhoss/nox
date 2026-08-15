<script lang="ts">
	/*
	 * Confirms deleting the current session outright.
	 *
	 * Unlike `ClearSessionDialog` no replacement session is created, so the
	 * Playground falls back to the blueprint's start state afterwards.
	 */
	import ConfirmDialog from "../shared/ConfirmDialog.svelte";
	import { deleteSession, status } from "../../stores/playground";

	type Props = { onclose: () => void };

	let { onclose }: Props = $props();

	const confirm = async (): Promise<void> => {
		await deleteSession();
		// Closed either way: on failure the error surfaces in the page notice.
		onclose();
	};
</script>

<ConfirmDialog
	title="Delete this session?"
	confirmLabel="Delete session"
	busyLabel="Deleting…"
	busy={$status.deleting}
	onconfirm={confirm}
	oncancel={onclose}
>
	{#snippet description()}
		The conversation, runs, and tool activity will be permanently deleted. No replacement session will be created.
	{/snippet}
</ConfirmDialog>
