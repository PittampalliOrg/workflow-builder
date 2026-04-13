<script lang="ts">
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		class: className,
		children,
		...restProps
	}: {
		class?: string;
		children?: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
	class={cn(
		"text-foreground prose prose-sm dark:prose-invert break-words whitespace-normal",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
