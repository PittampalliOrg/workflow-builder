<script lang="ts">
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";

	interface ToolCallProps {
		open?: boolean;
		class?: string;
		children?: Snippet;
		[key: string]: any;
	}

	let { open = $bindable(false), class: className = "", children, ...restProps }: ToolCallProps = $props();
</script>

<Collapsible bind:open class={cn("not-prose w-full rounded-lg border bg-card", className)} {...restProps}>
	{@render children?.()}
</Collapsible>
