<script lang="ts">
	import { cn } from "$lib/components/ui/utils";

	interface Props {
		class?: string;
		children?: import("svelte").Snippet;
	}

	let { class: className = "", children, ...props }: Props = $props();
</script>

<div class={cn("prose prose-sm max-w-none", className)} {...props}>
	{@render children?.()}
</div>
