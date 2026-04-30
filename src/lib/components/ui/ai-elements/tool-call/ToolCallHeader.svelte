<script lang="ts">
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { cn } from "$lib/components/ui/utils";
	import CheckCircle from "@lucide/svelte/icons/check-circle-2";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import Circle from "@lucide/svelte/icons/circle";
	import Clock from "@lucide/svelte/icons/clock";
	import XCircle from "@lucide/svelte/icons/x-circle";
	import Wrench from "@lucide/svelte/icons/wrench";

	type ToolCallState = "running" | "completed" | "error" | "pending";

	interface ToolCallHeaderProps {
		toolName: string;
		label?: string;
		state?: ToolCallState;
		icon?: any;
		iconClass?: string;
		/** Optional colored badge classes for the tool name (e.g., agent type colors).
		 *  Ported from claude-code-src userFacingNameBackgroundColor. */
		nameBadgeClass?: string;
		class?: string;
		[key: string]: any;
	}

	let {
		toolName,
		label,
		state = "completed",
		icon: ToolIcon = Wrench,
		iconClass = "text-muted-foreground",
		nameBadgeClass = "",
		class: className = "",
		...restProps
	}: ToolCallHeaderProps = $props();

	const statusConfig = {
		pending: { icon: Circle, label: "Pending", badgeClass: "" },
		running: { icon: Clock, label: "Running", badgeClass: "" },
		completed: { icon: CheckCircle, label: "Completed", badgeClass: "" },
		error: { icon: XCircle, label: "Error", badgeClass: "border-red-500/30" }
	} as const;

	let config = $derived(statusConfig[state]);
	let StatusIcon = $derived(config.icon);
</script>

<CollapsibleTrigger
	class={cn("group flex w-full items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50", className)}
	{...restProps}
>
	<ToolIcon class={cn("size-4 shrink-0", iconClass)} />
	<span class="min-w-0 flex-1 text-left">
		{#if nameBadgeClass}
			<span class={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold mr-1.5", nameBadgeClass)}>{toolName}</span>
			<span class="text-[13px] text-muted-foreground">{label}</span>
		{:else}
			<span class="text-[13px] font-medium text-foreground">{label || toolName}</span>
		{/if}
	</span>
	<Badge class={cn("gap-1 rounded-full px-2 text-[10px]", config.badgeClass)} variant={state === 'error' ? 'destructive' : 'secondary'}>
		<StatusIcon
			class={cn(
				"size-3",
				state === "running" && "animate-pulse",
				state === "completed" && "text-green-600 dark:text-green-400",
				state === "error" && "text-red-600 dark:text-red-400"
			)}
		/>
		{config.label}
	</Badge>
	<ChevronDown
		class="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
	/>
</CollapsibleTrigger>
