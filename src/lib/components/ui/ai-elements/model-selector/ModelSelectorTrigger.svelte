<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { Dialog as DialogPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: DialogPrimitive.TriggerProps & {
		children?: Snippet;
	} = $props();
</script>

<Dialog.Trigger bind:ref {...restProps}>
	{@render children?.()}
</Dialog.Trigger>
