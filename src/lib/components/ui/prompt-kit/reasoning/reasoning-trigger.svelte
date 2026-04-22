<script lang="ts">
	import { getReasoningContext } from "./reasoning-context.svelte";
	import { cn } from "$lib/components/ui/utils";
	import ChevronDown from "lucide-svelte/icons/chevron-down";
	import BrainCircuit from "lucide-svelte/icons/brain-circuit";
	import type { Snippet } from "svelte";

	interface Props {
		children?: Snippet;
		class?: string;
		[key: string]: any;
	}

	let { children, class: className, ...rest }: Props = $props();

	const context = getReasoningContext();
</script>

<button
	class={cn(
		"flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50",
		className
	)}
	onclick={() => context.toggle()}
	{...rest}
>
	<BrainCircuit class="size-4 shrink-0 text-muted-foreground" />
	<span class="flex-1 text-left text-muted-foreground">
		{#if children}
			{@render children()}
		{:else}
			Reasoned about the task
		{/if}
	</span>
	<ChevronDown
		class={cn(
			"size-4 shrink-0 text-muted-foreground transition-transform duration-200",
			context.isOpen && "rotate-180"
		)}
	/>
</button>
