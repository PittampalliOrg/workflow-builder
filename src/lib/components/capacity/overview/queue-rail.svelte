<script lang="ts">
	/**
	 * Horizontal rail container for the queue tiles. Provides snap classes
	 * and overflow behavior so 5+ tiles scroll smoothly on small screens.
	 */
	import type { Snippet } from 'svelte';

	type Props = {
		children: Snippet;
		ariaLabel?: string;
	};

	let { children, ariaLabel = 'Cluster queues' }: Props = $props();
</script>

<div
	class="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2"
	aria-label={ariaLabel}
	role="region"
>
	{@render children()}
</div>
