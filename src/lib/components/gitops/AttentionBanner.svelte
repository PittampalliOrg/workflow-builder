<script lang="ts">
	import { AlertTriangle, Flame, GitBranchPlus, ShieldAlert } from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { ENVIRONMENTS, type ServiceRow, summarizeMatrix } from "$lib/gitops/service-matrix";

	type Issue = {
		kind: "drift" | "failed-build" | "degraded" | "stuck-promotion";
		service: string;
		env: string;
		detail: string;
	};

	type Props = {
		rows: ServiceRow[];
		tektonBase: string | null;
		inventoryError?: string | null;
	};

	let { rows, tektonBase, inventoryError = null }: Props = $props();

	const summary = $derived(summarizeMatrix(rows));

	const issues = $derived.by(() => {
		const out: Issue[] = [];
		for (const row of rows) {
			for (const env of ENVIRONMENTS) {
				const cell = row.envs[env];
				if (!cell || cell.source !== "inventory") continue;

				if (cell.syncStatus === "OutOfSync" || cell.driftStatus === "pending_rollout") {
					out.push({
						kind: "drift",
						service: row.service,
						env,
						detail:
							cell.driftStatus === "pending_rollout"
								? "pending rollout"
								: (cell.syncStatus ?? "drift"),
					});
				}
				if (cell.healthStatus === "Degraded") {
					out.push({
						kind: "degraded",
						service: row.service,
						env,
						detail: "Degraded",
					});
				}
				if (
					cell.buildStatus === "False" ||
					cell.buildReason === "Failed" ||
					cell.buildReason === "Failure"
				) {
					out.push({
						kind: "failed-build",
						service: row.service,
						env,
						detail: cell.buildPipelineRun ?? cell.buildReason ?? "build failed",
					});
				}
				if (
					cell.promotionHealth &&
					cell.promotionHealth !== "Succeeded" &&
					cell.promotionHealth !== "Healthy"
				) {
					out.push({
						kind: "stuck-promotion",
						service: row.service,
						env,
						detail: `promotion ${cell.promotionHealth}`,
					});
				}
			}
		}
		return out;
	});

	const tektonUrl = $derived((pipelineRun: string) => {
		if (!tektonBase || !pipelineRun) return null;
		const base = tektonBase.replace(/\/+$/, "");
		return `${base}/#/namespaces/tekton-pipelines/pipelineruns/${encodeURIComponent(pipelineRun)}`;
	});

	const hasData = $derived(summary.servicesWithAnyEnv > 0);
	const shouldShow = $derived(inventoryError !== null || (hasData && issues.length > 0));

	const iconFor = (kind: Issue["kind"]) => {
		switch (kind) {
			case "drift":
				return GitBranchPlus;
			case "failed-build":
				return Flame;
			case "degraded":
				return ShieldAlert;
			case "stuck-promotion":
				return AlertTriangle;
		}
	};
</script>

{#if shouldShow}
	<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
		<div class="flex items-center gap-2 font-medium text-destructive">
			<AlertTriangle class="size-4" />
			What needs attention
		</div>

		{#if inventoryError}
			<div class="mt-2 text-destructive/90">
				Hub inventory fetch failed: <span class="font-mono text-xs">{inventoryError}</span>
			</div>
		{/if}

		{#if issues.length > 0}
			<div class="mt-2 flex flex-wrap gap-2">
				<Badge variant="destructive" class="text-[0.7rem]">
					{summary.driftCount} drift
				</Badge>
				{#if summary.failedBuilds > 0}
					<Badge variant="destructive" class="text-[0.7rem]">
						{summary.failedBuilds} failed builds
					</Badge>
				{/if}
				{#if summary.degradedApps > 0}
					<Badge variant="destructive" class="text-[0.7rem]">
						{summary.degradedApps} degraded
					</Badge>
				{/if}
				{#if summary.pendingPromotions > 0}
					<Badge variant="outline" class="text-[0.7rem]">
						{summary.pendingPromotions} promotions in-flight
					</Badge>
				{/if}
			</div>

			<ul class="mt-3 space-y-1.5 text-xs">
				{#each issues.slice(0, 10) as issue (`${issue.kind}:${issue.service}:${issue.env}`)}
					{@const IssueIcon = iconFor(issue.kind)}
					<li class="flex items-center gap-2">
						<IssueIcon class="size-3 text-destructive/80" />
						<span class="font-medium">{issue.service}</span>
						<span class="text-muted-foreground">on</span>
						<span class="font-mono text-muted-foreground">{issue.env}</span>
						{#if issue.kind === "failed-build" && tektonUrl(issue.detail)}
							<a class="ml-1 text-primary hover:underline" href={tektonUrl(issue.detail)} target="_blank" rel="noreferrer">
								{issue.detail}
							</a>
						{:else}
							<span class="ml-1 text-muted-foreground">{issue.detail}</span>
						{/if}
					</li>
				{/each}
				{#if issues.length > 10}
					<li class="text-xs text-muted-foreground">…and {issues.length - 10} more.</li>
				{/if}
			</ul>
		{/if}
	</div>
{/if}
