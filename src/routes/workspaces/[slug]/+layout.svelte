<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setContext } from 'svelte';
	import { page } from '$app/state';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let slug = $derived(page.params.slug as string);

	// Expose the slug to descendants via context. Pages can read via:
	//   const slug = getContext<() => string>('workspaceSlug')();
	setContext('workspaceSlug', () => slug);
</script>

{@render children()}
