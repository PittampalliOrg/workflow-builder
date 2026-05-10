<script lang="ts">
	import { CheckCircle2, CircleAlert, CircleHelp, Clock3 } from "@lucide/svelte";

	import { cn } from "$lib/components/ui/utils.js";

	type Phase = "success" | "pending" | "failure" | "unknown" | string;
	type Props = {
		phase: Phase | null | undefined;
		size?: "xs" | "sm" | "md";
		class?: string;
	};

	let { phase, size = "sm", class: className }: Props = $props();

	const Icon = $derived(
		phase === "success"
			? CheckCircle2
			: phase === "failure"
				? CircleAlert
				: phase === "pending"
					? Clock3
					: CircleHelp,
	);

	const tone = $derived(
		phase === "success"
			? "text-emerald-500"
			: phase === "failure"
				? "text-destructive"
				: phase === "pending"
					? "text-amber-500"
					: "text-muted-foreground",
	);

	const sizeClass = $derived(size === "xs" ? "size-3" : size === "md" ? "size-4" : "size-3.5");
</script>

<Icon class={cn(sizeClass, tone, className)} />
