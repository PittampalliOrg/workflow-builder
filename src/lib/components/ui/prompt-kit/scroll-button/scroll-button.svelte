<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import { cn } from "$lib/components/ui/utils";
	import ArrowDown from "lucide-svelte/icons/arrow-down";
	import { getChatContainerContext } from "../chat-container/chat-container-context.svelte";

	let {
		class: className,
		...restProps
	}: {
		class?: string;
		[key: string]: any;
	} = $props();

	const context = getChatContainerContext();
	let isAtBottom = $derived(context.isAtBottom);
</script>

{#if !isAtBottom}
	<div
		class={cn(
			"sticky bottom-4 z-10 flex justify-center pointer-events-none",
			className
		)}
		{...restProps}
	>
		<Button
			variant="secondary"
			size="sm"
			class="pointer-events-auto gap-1.5 rounded-full shadow-lg"
			onclick={() => context.scrollToBottom("smooth")}
		>
			<ArrowDown class="size-3.5" />
			<span class="text-xs">Scroll to bottom</span>
		</Button>
	</div>
{/if}
