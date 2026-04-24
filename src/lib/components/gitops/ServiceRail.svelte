<script lang="ts">
	import { AlertTriangle } from "lucide-svelte";

	import { Button } from "$lib/components/ui/button";
	import { ENVIRONMENTS, type ServiceRow } from "$lib/gitops/service-matrix";

	type Props = {
		rows: ServiceRow[];
		onSelect?: (service: string) => void;
	};

	let { rows, onSelect }: Props = $props();

	function rowHasIssue(row: ServiceRow): boolean {
		for (const env of ENVIRONMENTS) {
			const cell = row.envs[env];
			if (!cell) continue;
			if (cell.syncStatus === "OutOfSync") return true;
			if (cell.healthStatus === "Degraded") return true;
			if (cell.driftStatus === "pending_rollout") return true;
			if (cell.buildStatus === "False" || cell.buildReason === "Failed") return true;
		}
		return false;
	}

	function jump(service: string) {
		if (onSelect) {
			onSelect(service);
			return;
		}
		const el = document.getElementById(`strip-${service}`);
		if (!el) return;
		// `scrollIntoView({ behavior: 'smooth' })` silently fails on this page's
		// deeply-nested `overflow-auto` layout in Chrome (confirmed via devtools
		// — scrollTop never advances). Drop the behavior option so the browser
		// uses its default instant scroll, which works reliably.
		el.scrollIntoView({ block: "start" });
	}
</script>

<nav
	aria-label="Jump to service"
	class="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card/30 px-2 py-1.5"
>
	<span class="shrink-0 pr-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
		jump to
	</span>
	{#each rows as row (row.service)}
		{@const issue = rowHasIssue(row)}
		<Button
			size="sm"
			variant="ghost"
			class="h-6 shrink-0 gap-1 px-2 text-[0.7rem] font-normal {issue ? 'text-amber-700 dark:text-amber-300' : ''}"
			onclick={() => jump(row.service)}
			title={issue ? `${row.service} — needs attention` : row.service}
		>
			{#if issue}
				<AlertTriangle class="size-3" />
			{/if}
			{row.service}
		</Button>
	{/each}
</nav>
