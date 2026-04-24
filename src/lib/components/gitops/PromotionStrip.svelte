<script lang="ts">
	import { Package } from "lucide-svelte";

	import EnvCard from "$lib/components/gitops/EnvCard.svelte";
	import GateChip from "$lib/components/gitops/GateChip.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { argoGates, releasePrGate } from "$lib/gitops/gates";
	import type { EnvName, ServiceRow } from "$lib/gitops/service-matrix";

	type Props = {
		row: ServiceRow;
		envsVisible?: Record<EnvName, boolean>;
	};

	let {
		row,
		envsVisible = { ryzen: true, dev: true, staging: true },
	}: Props = $props();

	const prGate = $derived(releasePrGate(row.envs.ryzen, row.envs.dev));
	const promoGate = $derived(argoGates(row.envs.dev, row.envs.staging));

	const specialCaseLabel = $derived.by(() => {
		switch (row.specialCase) {
			case "single-source":
				return "single-source";
			case "sandbox-only":
				return "sandbox";
			case "ryzen-missing-pin":
				return "no ryzen pin";
			case "ryzen-only":
				return "ryzen-only";
			default:
				return null;
		}
	});

	const hasIssue = $derived.by(() => {
		for (const env of ["ryzen", "dev", "staging"] as const) {
			const cell = row.envs[env];
			if (!cell) continue;
			if (cell.syncStatus === "OutOfSync") return true;
			if (cell.healthStatus === "Degraded") return true;
			if (cell.driftStatus === "pending_rollout") return true;
			if (cell.buildStatus === "False" || cell.buildReason === "Failed") return true;
		}
		return false;
	});
</script>

<section
	id={`strip-${row.service}`}
	class="rounded-xl border p-3 transition-shadow scroll-mt-24 hover:shadow-sm
		{hasIssue ? 'bg-amber-50/30 ring-1 ring-amber-300/40 dark:bg-amber-950/10' : 'bg-card/40'}"
>
	<header class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
		<div class="flex items-center gap-2">
			<Package class="size-4 text-muted-foreground" />
			<h3 class="font-semibold">{row.service}</h3>
			{#if specialCaseLabel}
				<Badge variant="outline" class="h-4 px-1.5 text-[0.6rem] font-normal">
					{specialCaseLabel}
				</Badge>
			{/if}
		</div>
	</header>

	<div
		class="flex items-stretch gap-1.5 overflow-x-auto snap-x snap-proximity scroll-smooth"
	>
		{#if envsVisible.ryzen}
			<EnvCard env="ryzen" cell={row.envs.ryzen} specialCase={row.specialCase} />
			<GateChip kind="release-pr" state={prGate} />
		{/if}
		{#if envsVisible.dev}
			<EnvCard env="dev" cell={row.envs.dev} specialCase={row.specialCase} />
			{#if envsVisible.staging}
				<GateChip kind="argo-gates" state={promoGate} />
			{/if}
		{/if}
		{#if envsVisible.staging}
			<EnvCard env="staging" cell={row.envs.staging} specialCase={row.specialCase} />
		{/if}
	</div>
</section>
