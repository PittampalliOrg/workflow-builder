<script lang="ts">
	import { getReasoningContext } from "./reasoning-context.svelte";
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";

	interface Props {
		children?: Snippet;
		class?: string;
		[key: string]: any;
	}

	let { children, class: className, ...rest }: Props = $props();

	const context = getReasoningContext();
</script>

{#if context.isOpen}
	<div
		class={cn("border-t px-3 py-3 text-muted-foreground", className)}
		{...rest}
	>
		{@render children?.()}
	</div>
{/if}
