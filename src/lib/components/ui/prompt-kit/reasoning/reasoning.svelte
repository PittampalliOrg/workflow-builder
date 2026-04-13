<script lang="ts">
	import { setReasoningContext } from "./reasoning-context.svelte";
	import { cn } from "$lib/components/ui/utils";
	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
		open?: boolean;
		class?: string;
		[key: string]: any;
	}

	let { children, open = false, class: className, ...rest }: Props = $props();

	setReasoningContext(open);
</script>

<div class={cn("rounded-lg border bg-card", className)} {...rest}>
	{@render children()}
</div>
