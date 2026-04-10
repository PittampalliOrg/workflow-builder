<script lang="ts">
	import { cn } from "$lib/components/ui/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	type Variant = "contained" | "flat";

	type MessageContentProps = HTMLAttributes<HTMLDivElement> & {
		variant?: Variant;
	};

	let { class: className = "", variant = "contained", children, ...restProps }: MessageContentProps = $props();

	const variantClasses: Record<Variant, string> = {
		contained: [
			"max-w-[90%] rounded-lg px-3 py-2",
			"group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground",
			"group-[.is-assistant]:bg-secondary group-[.is-assistant]:text-foreground",
			"group-[.is-tool]:bg-muted/50 group-[.is-tool]:text-foreground group-[.is-tool]:border group-[.is-tool]:border-border/50",
		].join(" "),
		flat: [
			"group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:max-w-[90%] group-[.is-user]:rounded-lg group-[.is-user]:px-3 group-[.is-user]:py-2",
			"group-[.is-assistant]:text-foreground",
			"group-[.is-tool]:text-foreground group-[.is-tool]:font-mono group-[.is-tool]:text-xs",
		].join(" "),
	};
</script>

<div class={cn("flex min-w-0 flex-1 flex-col gap-1 overflow-hidden text-sm", variantClasses[variant], className)} {...restProps}>
	{@render children?.()}
</div>
