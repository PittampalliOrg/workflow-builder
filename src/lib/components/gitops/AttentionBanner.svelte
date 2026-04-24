<script lang="ts">
	import {
		AlertTriangle,
		ChevronDown,
		ChevronRight,
		Flame,
		GitBranchPlus,
		ShieldAlert,
	} from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { isPromotionPassing } from "$lib/gitops/gates";
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
		onJumpToService?: (service: string) => void;
	};

	let { rows, tektonBase, inventoryError = null, onJumpToService }: Props = $props();

	let expanded = $state(false);

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
				if (cell.promotionHealth && !isPromotionPassing(cell.promotionHealth)) {
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

	const hasIssues = $derived(issues.length > 0);
	const shouldShow = $derived(inventoryError !== null || hasIssues);

	// Drift-only state is a transient, self-healing "still promoting" case — soften the colour.
	const isTransientOnly = $derived(
		hasIssues &&
			inventoryError === null &&
			summary.failedBuilds === 0 &&
			summary.degradedApps === 0,
	);

	const banner = $derived(
		inventoryError !== null
			? "border-destructive/30 bg-destructive/5 text-destructive"
			: isTransientOnly
				? "border-amber-300/50 bg-amber-50/40 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200"
				: "border-destructive/30 bg-destructive/5 text-destructive",
	);

	const LIMIT = 5;
	const visibleIssues = $derived(expanded ? issues : issues.slice(0, LIMIT));

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
	<div class="rounded-lg border {banner} p-3 text-sm">
		<div class="flex items-center gap-2 font-medium">
			<AlertTriangle class="size-4" />
			<span>{isTransientOnly ? "Rollout in progress" : "What needs attention"}</span>
		</div>

		{#if inventoryError}
			<div class="mt-2 text-destructive/90">
				Hub inventory fetch failed: <span class="font-mono text-xs">{inventoryError}</span>
			</div>
		{/if}

		{#if hasIssues}
			<div class="mt-2 flex flex-wrap gap-1.5">
				{#if summary.driftCount > 0}
					<Badge
						variant={isTransientOnly ? "outline" : "destructive"}
						class="h-5 px-1.5 text-[0.65rem]"
					>
						{summary.driftCount} drift
					</Badge>
				{/if}
				{#if summary.failedBuilds > 0}
					<Badge variant="destructive" class="h-5 px-1.5 text-[0.65rem]">
						{summary.failedBuilds} failed builds
					</Badge>
				{/if}
				{#if summary.degradedApps > 0}
					<Badge variant="destructive" class="h-5 px-1.5 text-[0.65rem]">
						{summary.degradedApps} degraded
					</Badge>
				{/if}
				{#if summary.pendingPromotions > 0}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
						{summary.pendingPromotions} promotions in-flight
					</Badge>
				{/if}
			</div>

			<ul class="mt-2 space-y-1 text-xs">
				{#each visibleIssues as issue (`${issue.kind}:${issue.service}:${issue.env}`)}
					{@const IssueIcon = iconFor(issue.kind)}
					<li class="flex items-center gap-2">
						<IssueIcon class="size-3 shrink-0 opacity-70" />
						{#if onJumpToService}
							<button
								type="button"
								class="font-medium hover:underline"
								onclick={() => onJumpToService?.(issue.service)}
							>
								{issue.service}
							</button>
						{:else}
							<span class="font-medium">{issue.service}</span>
						{/if}
						<span class="opacity-60">on</span>
						<span class="font-mono opacity-70">{issue.env}</span>
						{#if issue.kind === "failed-build" && tektonUrl(issue.detail)}
							<a class="ml-1 text-primary hover:underline" href={tektonUrl(issue.detail)} target="_blank" rel="noreferrer">
								{issue.detail}
							</a>
						{:else}
							<span class="ml-1 opacity-70">{issue.detail}</span>
						{/if}
					</li>
				{/each}
			</ul>

			{#if issues.length > LIMIT}
				<Button
					variant="link"
					size="sm"
					class="mt-1 h-6 gap-1 px-0 text-xs"
					onclick={() => (expanded = !expanded)}
				>
					{#if expanded}
						<ChevronDown class="size-3" />
						Show fewer
					{:else}
						<ChevronRight class="size-3" />
						View {issues.length - LIMIT} more
					{/if}
				</Button>
			{/if}
		{/if}
	</div>
{/if}
