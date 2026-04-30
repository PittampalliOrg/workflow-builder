<script lang="ts">
	import { cn } from "$lib/components/ui/utils.js";
	import { Badge } from "$lib/components/ui/badge";
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "$lib/components/ui/collapsible";
	import { ChevronDown, Wrench, CheckCircle, XCircle, Clock } from "@lucide/svelte";

	interface Props {
		name: string;
		state: "pending" | "running" | "completed" | "error";
		class?: string;
		children?: import("svelte").Snippet;
	}

	let { name, state, class: className = "", children }: Props = $props();

	const stateConfig = $derived({
		pending: { label: "Pending", icon: Clock, variant: "outline" as const },
		running: { label: "Running", icon: Clock, variant: "default" as const },
		completed: { label: "Completed", icon: CheckCircle, variant: "secondary" as const },
		error: { label: "Error", icon: XCircle, variant: "destructive" as const },
	}[state]);
</script>

<Collapsible open={state === "completed" || state === "error"} class={cn("rounded-md border", className)}>
	<CollapsibleTrigger class="flex w-full items-center justify-between gap-3 p-2.5 text-left">
		<div class="flex items-center gap-2">
			<Wrench class="text-muted-foreground h-3.5 w-3.5" />
			<span class="text-xs font-medium">{name}</span>
			<Badge variant={stateConfig.variant} class="gap-1 text-[10px]">
				<stateConfig.icon class={cn("h-3 w-3", state === "running" && "animate-pulse", state === "completed" && "text-green-600", state === "error" && "text-red-600")} />
				{stateConfig.label}
			</Badge>
		</div>
		<ChevronDown class="text-muted-foreground h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
	</CollapsibleTrigger>
	<CollapsibleContent>
		{@render children?.()}
	</CollapsibleContent>
</Collapsible>
