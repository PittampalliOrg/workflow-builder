<script lang="ts">
	import { ArrowRight } from "@lucide/svelte";

	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import type { EnvCardModel } from "$lib/promoter/pipeline-view";

	type Props = {
		from: EnvCardModel;
		to: EnvCardModel;
	};

	let { from, to }: Props = $props();

	// Use the *next* env's proposed checks (if any) as the gate state.
	const phase = $derived.by(() => {
		const proposed = to.proposed;
		if (!proposed) return "success";
		if (proposed.checks.failure > 0) return "failure";
		if (proposed.checks.pending > 0) return "pending";
		return "success";
	});

	// Look up the timer commit-status's `description` (e.g. "soaking 4m of 10m")
	// so the connector matches what TimedCommitStatus emits server-side.
	const timerDescription = $derived(
		to.proposed?.commitStatuses.find((c) => c.key === "timer")?.description ?? null,
	);

	const label = $derived.by(() => {
		if (timerDescription) return timerDescription;
		if (phase === "success") return "promoted";
		if (phase === "pending") return "soaking";
		return "blocked";
	});

	const fromLastSha = $derived(from.active.dry?.sha?.slice(0, 8) ?? null);
	const toProposedSha = $derived(to.proposed?.dry?.sha?.slice(0, 8) ?? null);

	const variant = $derived(
		phase === "failure" ? "destructive" : phase === "pending" ? "outline" : "secondary",
	);
</script>

<div class="flex w-12 flex-col items-center justify-center self-stretch gap-1 px-1 text-muted-foreground">
	<ArrowRight class="size-4" />
	<Badge {variant} class="h-5 gap-1 px-1.5 text-[0.6rem] font-normal">
		<StatusIcon {phase} size="xs" />
		{label}
	</Badge>
	{#if fromLastSha && toProposedSha && fromLastSha === toProposedSha}
		<div class="font-mono text-[0.55rem] text-muted-foreground/80" title="dry SHA in flight">
			{toProposedSha}
		</div>
	{/if}
</div>
