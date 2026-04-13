<script lang="ts">
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";

	interface ToolCallContentProps {
		class?: string;
		children?: Snippet;
		[key: string]: any;
	}

	let { class: className = "", children, ...restProps }: ToolCallContentProps = $props();
</script>

<CollapsibleContent
	class={cn("border-t", className)}
	{...restProps}
>
	{@render children?.()}
</CollapsibleContent>
