<script lang="ts">
	import { cn } from "$lib/components/ui/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	type MessageLabelProps = HTMLAttributes<HTMLSpanElement>;

	let { class: className = "", children, ...restProps }: MessageLabelProps = $props();
</script>

<span
	class={cn(
		"text-[10px] font-medium uppercase tracking-wider",
		"group-[.is-user]:text-primary-foreground/70",
		"group-[.is-assistant]:text-muted-foreground",
		"group-[.is-tool]:text-muted-foreground",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</span>
