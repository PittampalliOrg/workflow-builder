<script lang="ts">
	import { Package } from "lucide-svelte";

	import EnvCard from "$lib/components/gitops/EnvCard.svelte";
	import GateChip from "$lib/components/gitops/GateChip.svelte";
	import { argoGates, releasePrGate } from "$lib/gitops/gates";
	import type { ServiceRow } from "$lib/gitops/service-matrix";

	type Props = {
		row: ServiceRow;
	};

	let { row }: Props = $props();

	const prGate = $derived(releasePrGate(row.envs.ryzen, row.envs.dev));
	const promoGate = $derived(argoGates(row.envs.dev, row.envs.staging));

	const specialCaseLabel = $derived.by(() => {
		switch (row.specialCase) {
			case "single-source":
				return "single-source across all envs";
			case "sandbox-only":
				return "runtime-launched sandbox";
			case "ryzen-missing-pin":
				return "no ryzen kustomization pin";
			case "ryzen-only":
				return "ryzen-only (no dev/staging promotion)";
			default:
				return null;
		}
	});
</script>

<section class="rounded-xl border bg-card/40 p-4">
	<header class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<div class="flex items-center gap-2">
			<Package class="size-4 text-muted-foreground" />
			<h3 class="font-semibold">{row.service}</h3>
			{#if specialCaseLabel}
				<span class="text-[0.66rem] uppercase tracking-wide text-muted-foreground">
					{specialCaseLabel}
				</span>
			{/if}
		</div>
	</header>

	<div class="flex flex-wrap items-stretch gap-2 md:flex-nowrap">
		<EnvCard env="ryzen" cell={row.envs.ryzen} specialCase={row.specialCase} />
		<GateChip kind="release-pr" state={prGate} />
		<EnvCard env="dev" cell={row.envs.dev} specialCase={row.specialCase} />
		<GateChip kind="argo-gates" state={promoGate} />
		<EnvCard env="staging" cell={row.envs.staging} specialCase={row.specialCase} />
	</div>
</section>
