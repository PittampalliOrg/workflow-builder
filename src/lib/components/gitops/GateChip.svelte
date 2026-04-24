<script lang="ts">
	import { ArrowRight, Check, Clock3, CircleAlert, CircleHelp } from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import type { GateState } from "$lib/gitops/gates";

	type Props = {
		kind: "release-pr" | "argo-gates";
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

	const gateTitle = $derived(kind === "release-pr" ? "release PR" : "Promoter gates");
</script>

<div class="flex min-w-[7rem] flex-col items-center gap-1 px-2">
	<div class="flex w-full items-center justify-center gap-1 text-muted-foreground/60">
		<div class="h-px flex-1 bg-border"></div>
		<ArrowRight class="size-3" />
		<div class="h-px flex-1 bg-border"></div>
	</div>
	<Badge {variant} class="gap-1 font-normal" title={`${gateTitle}: ${state.tooltip}`}>
		<Icon class="size-3" />
		{state.label}
	</Badge>
	<div class="text-[0.66rem] text-muted-foreground">{gateTitle}</div>
</div>
