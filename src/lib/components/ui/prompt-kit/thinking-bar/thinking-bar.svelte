<script lang="ts">
	import { cn } from "$lib/components/ui/utils";

	let {
		text = "Thinking",
		class: className,
		...restProps
	}: {
		text?: string;
		class?: string;
		[key: string]: any;
	} = $props();
</script>

<div
	class={cn(
		"flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2",
		className
	)}
	{...restProps}
>
	<span class="relative flex size-1.5">
		<span class="absolute inline-flex size-full animate-ping rounded-full bg-muted-foreground/50 opacity-60"></span>
		<span class="relative inline-flex size-1.5 rounded-full bg-muted-foreground/70"></span>
	</span>
	<span class="thinking-shimmer text-sm font-medium">{text}…</span>
</div>

<style>
	.thinking-shimmer {
		background: linear-gradient(
			90deg,
			hsl(var(--foreground) / 0.95) 0%,
			hsl(var(--muted-foreground) / 0.45) 50%,
			hsl(var(--foreground) / 0.95) 100%
		);
		background-size: 200% auto;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shimmer 2.4s linear infinite;
	}

	@keyframes shimmer {
		0% {
			background-position: 200% center;
		}
		100% {
			background-position: -200% center;
		}
	}
</style>
