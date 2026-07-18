<script lang="ts">
	import {
		AlertTriangle,
		CheckCircle2,
		Clock3,
		GitPullRequest,
		Workflow,
	} from "@lucide/svelte";

	import type { GitopsPageLinks } from "$lib/gitops/links";
	import {
		buildPromotionPulse,
		type PulsePhase,
	} from "$lib/gitops/promotion-pulse";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	type Props = {
		promotions: PromotionStrategiesResponse;
		links: GitopsPageLinks;
		onOpenStrategy?: (name: string) => void;
	};

	let { promotions, links, onOpenStrategy }: Props = $props();

	const pulse = $derived(
		buildPromotionPulse(promotions, { stacksRepoUrl: links.stacksRepo }),
	);

	function phaseIcon(phase: PulsePhase) {
		if (phase === "failure") return AlertTriangle;
		if (phase === "pending") return Clock3;
		return CheckCircle2;
	}

	function phaseColor(phase: PulsePhase): string {
		if (phase === "failure") return "text-destructive";
		if (phase === "pending") return "text-amber-500";
		if (phase === "success") return "text-emerald-500";
		return "text-muted-foreground/50";
	}

	function chipClasses(phase: PulsePhase): string {
		if (phase === "failure") {
			return "border-destructive/40 bg-destructive/10 text-destructive";
		}
		if (phase === "pending") {
			return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200";
		}
		if (phase === "success") {
			return "border-emerald-300/60 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200";
		}
		return "border-border bg-muted/40 text-muted-foreground";
	}
</script>

<!-- Compact promotion / env-branch state: strategies with per-branch phase
     chips, plus open promotion PRs (all linkified). -->
{#if pulse.rows.length > 0 || pulse.openPrs.length > 0}
	<div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card px-4 py-2.5">
		<span class="inline-flex items-center gap-1.5 text-xs font-medium">
			<Workflow class="size-3.5 text-muted-foreground" />
			Promotions
			{#if pulse.changeTransferPolicyCount > 0}
				<span class="text-[0.65rem] text-muted-foreground">
					· {pulse.changeTransferPolicyCount} transfer polic{pulse.changeTransferPolicyCount === 1
						? "y"
						: "ies"}
				</span>
			{/if}
		</span>
		{#each pulse.rows as row (row.name)}
			{@const RowPhaseIcon = phaseIcon(row.phase)}
			<span class="inline-flex min-w-0 items-center gap-1.5">
				{#if onOpenStrategy}
					<button
						type="button"
						class="inline-flex items-center gap-1 truncate text-xs font-medium hover:underline"
						onclick={() => onOpenStrategy?.(row.name)}
						title={`Open ${row.name} in the Promotions tab`}
					>
						<RowPhaseIcon class="size-3.5 {phaseColor(row.phase)}" />
						{row.name}
					</button>
				{:else}
					<span class="inline-flex items-center gap-1 truncate text-xs font-medium">
						<RowPhaseIcon class="size-3.5 {phaseColor(row.phase)}" />
						{row.name}
					</span>
				{/if}
				<span class="flex items-center gap-1">
					{#each row.envs as env (env.branch)}
						<a
							class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.65rem] font-medium hover:opacity-80 {chipClasses(
								env.phase,
							)}"
							href={env.prUrl ?? env.branchUrl}
							target="_blank"
							rel="noreferrer"
							title={`${env.branch}: ${env.phase}${env.inFlight ? " (promotion in flight)" : ""}${env.prNumber ? ` · PR #${env.prNumber}` : ""}`}
						>
							{env.shortBranch}
							{#if env.prNumber != null}
								<GitPullRequest class="size-2.5" />
								#{env.prNumber}
							{/if}
						</a>
					{/each}
				</span>
			</span>
		{/each}
		{#if pulse.openPrs.length > 0}
			<span class="flex items-center gap-1.5">
				{#each pulse.openPrs as pr (pr.number ?? `${pr.sourceBranch}-${pr.targetBranch}`)}
					<a
						class="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[0.65rem] font-medium text-foreground hover:bg-muted"
						href={pr.url ?? `${links.stacksRepo}/pulls`}
						target="_blank"
						rel="noreferrer"
						title={pr.title
							? `${pr.title} (${pr.sourceBranch} → ${pr.targetBranch})`
							: `${pr.sourceBranch} → ${pr.targetBranch}`}
					>
						<GitPullRequest class="size-2.5" />
						{pr.number != null ? `#${pr.number}` : "PR"} open
					</a>
				{/each}
			</span>
		{/if}
	</div>
{/if}
