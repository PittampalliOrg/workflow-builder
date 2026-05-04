<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import type { Command as CommandPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: CommandPrimitive.ItemProps & {
		children?: Snippet;
	} = $props();
</script>

<Command.Item bind:ref {...restProps}>
	{@render children?.()}
</Command.Item>
