<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import type { Command as CommandPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		ref = $bindable(null),
		heading,
		children,
		...restProps
	}: CommandPrimitive.GroupProps & {
		heading?: string;
		children?: Snippet;
	} = $props();
</script>

<Command.Group bind:ref {heading} {...restProps}>
	{@render children?.()}
</Command.Group>
