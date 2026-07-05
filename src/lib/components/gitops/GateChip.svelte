<script lang="ts">
	import { ArrowRight, Check, CircleAlert, CircleHelp, Clock3 } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import type { GateState } from "$lib/gitops/gates";

	type Props = {
		kind: "release-pr" | "argo-gates" | "pr-preview-verify";
		state: GateState;
	};

	let { kind, state }: Props = $props();

	const variant = $derived(
		state.status === "passed"
			? "secondary"
			: state.status === "failed"
				? "destructive"
				: "outline",
	);

	const Icon = $derived(
		state.status === "passed"
			? Check
			: state.status === "failed"
				? CircleAlert
				: state.status === "unknown"
					? CircleHelp
					: Clock3,
	);

	const gateTitle = $derived(
		kind === "release-pr"
			? "release PR"
			: kind === "pr-preview-verify"
				? "preview verify"
				: "Promoter gates",
	);

	/**
	 * When there is genuinely nothing to report (ryzen missing from hub
	 * inventory, or missing cells), collapse the chip to a thin muted arrow so
	 * it doesn't dominate the row.
	 */
	const compact = $derived(state.status === "unknown" && state.label === "no data");
</script>

{#if compact}
	<div class="flex min-w-[1.5rem] items-center justify-center text-muted-foreground/40" title={`${gateTitle}: ${state.tooltip}`}>
		<ArrowRight class="size-3" />
	</div>
{:else}
	<div class="group flex min-w-[5.5rem] flex-col items-center gap-0.5 px-1">
		<Badge
			{variant}
			class="h-5 gap-1 px-1.5 text-[0.62rem] font-normal"
			title={`${gateTitle}: ${state.tooltip}`}
		>
			<Icon class="size-3" />
			{state.label}
		</Badge>
		<div class="text-[0.6rem] text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100">
			{gateTitle}
		</div>
	</div>
{/if}
