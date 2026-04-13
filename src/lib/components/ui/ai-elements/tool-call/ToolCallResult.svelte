<script lang="ts">
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";

	interface ToolCallResultProps {
		label?: string;
		error?: boolean;
		class?: string;
		children?: Snippet;
		[key: string]: any;
	}

	let {
		label = "Result",
		error = false,
		class: className = "",
		children,
		...restProps
	}: ToolCallResultProps = $props();
</script>

<div class={cn("space-y-2 p-3", className)} {...restProps}>
	<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
		{error ? "Error" : label}
	</h4>
	<div
		class={cn(
			"overflow-auto rounded-md text-[12px]",
			error ? "border border-red-500/20 bg-red-950/20 text-red-400" : "bg-muted/50 ring-1 ring-border/50"
		)}
	>
		{@render children?.()}
	</div>
</div>
