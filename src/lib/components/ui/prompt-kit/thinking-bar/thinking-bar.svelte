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
		"flex items-center gap-2.5 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-2.5",
		className
	)}
	{...restProps}
>
	<div class="relative flex items-center">
		<span class="thinking-shimmer text-sm font-medium text-blue-400">{text}...</span>
	</div>
</div>

<style>
	.thinking-shimmer {
		background: linear-gradient(
			90deg,
			oklch(0.707 0.165 254.624) 0%,
			oklch(0.707 0.165 254.624 / 0.4) 50%,
			oklch(0.707 0.165 254.624) 100%
		);
		background-size: 200% auto;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shimmer 2s linear infinite;
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
