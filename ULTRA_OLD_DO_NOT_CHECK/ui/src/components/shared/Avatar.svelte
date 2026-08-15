<script lang="ts">
	import { Avatar, Style } from "@dicebear/core";
	import botttsNeutralDefinition from "@dicebear/styles/bottts-neutral.json";
	import pixelArtNeutralDefinition from "@dicebear/styles/pixel-art-neutral.json";

	type Props = {
		/** Rendered without an accessible name, for a purely ornamental avatar. */
		decorative?: boolean;
		kind?: "blueprint" | "user";
		label?: string;
		/** Stable input for the generator: the same seed always draws the same face. */
		seed: string;
		size?: number;
	};

	let { decorative = false, kind = "blueprint", label = "", seed, size = 32 }: Props = $props();

	const blueprintStyle = new Style(botttsNeutralDefinition);
	const userStyle = new Style(pixelArtNeutralDefinition);

	const source = $derived(
		new Avatar(kind === "blueprint" ? blueprintStyle : userStyle, { seed }).toDataUri(),
	);
</script>

<img
	class:blueprint={kind === "blueprint"}
	class:user={kind === "user"}
	class="dicebear-avatar"
	src={source}
	alt={decorative ? "" : `${label || kind} avatar`}
	width={size}
	height={size}
	style={`--avatar-size: ${size}px`}
	decoding="async"
/>

<style>
	.dicebear-avatar {
		display: block;
		width: var(--avatar-size);
		height: var(--avatar-size);
		flex: 0 0 auto;
		object-fit: cover;
		border: 1px solid;
		border-radius: 22%;
	}

	.blueprint {
		background: #172533;
		border-color: rgb(118 162 206 / 24%);
	}

	.user {
		background: #20241f;
		border-color: #394139;
		border-radius: 50%;
	}
</style>
