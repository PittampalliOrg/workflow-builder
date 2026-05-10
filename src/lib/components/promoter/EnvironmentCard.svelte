<script lang="ts">
	import { ExternalLink, GitPullRequest, HardDrive } from "@lucide/svelte";

	import CommitInfo from "$lib/components/promoter/CommitInfo.svelte";
	import HealthSummary from "$lib/components/promoter/HealthSummary.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import type { EnvCardModel } from "$lib/promoter/pipeline-view";
	import {
		argoCdAppUrl,
		giteaBranchUrl,
		githubBranchUrl,
		githubPrUrl,
		repoBrowseUrl,
	} from "$lib/promoter/links";
	import type { CommitStatusEntry } from "$lib/server/promoter/types";

	type Props = {
		card: EnvCardModel;
		gitRepoUrl: string | null;
		argoCdBase: string;
		giteaBase?: string | null;
	};

	let { card, gitRepoUrl, argoCdBase, giteaBase = null }: Props = $props();

	// Pull the argocd-health CommitStatus for an inline link to the ArgoCD app.
	const argoCdCheck: CommitStatusEntry | null = $derived(
		card.active.commitStatuses.find((c) => c.key === "argocd-health") ?? null,
	);
	const argoCdUrl = $derived(argoCdCheck?.url ?? null);

	// Each env-branch maps to one ArgoCD application by name convention
	// (`<env>-<system>` with this stack), but we don't always know the prefix.
	// We rely on the CommitStatus URL when present (it's set by the promoter
	// itself); fallback to opening the ArgoCD home if not.
	const branchRepoUrl = $derived(repoBrowseUrl(gitRepoUrl));
	const branchHref = $derived(githubBranchUrl(branchRepoUrl, card.branch));
	const giteaHref = $derived(giteaBranchUrl(giteaBase, card.branch));
	const prUrl = $derived(
		card.proposed?.pullRequest
			? githubPrUrl(branchRepoUrl, card.proposed.pullRequest.metadata.labels?.["promoter.argoproj.io/pull-request-id"] ?? card.proposed.pullRequest.status?.id)
			: null,
	);

	const cardTone = $derived.by(() => {
		const proposed = card.proposed?.checks;
		if (proposed?.failure && proposed.failure > 0)
			return "border-destructive/40 bg-destructive/5";
		if (card.active.checks.failure > 0) return "border-destructive/40 bg-destructive/5";
		if (proposed && proposed.pending > 0)
			return "border-amber-300/60 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-950/20";
		return "border-emerald-300/40 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-950/20";
	});
</script>

<section
	class="flex min-w-[19rem] max-w-[24rem] flex-1 flex-col gap-2.5 rounded-xl border p-3 shadow-sm {cardTone}"
>
	<header class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1.5 text-xs">
			<HardDrive class="size-3.5 text-muted-foreground" />
			{#if branchHref}
				<a
					href={branchHref}
					target="_blank"
					rel="noreferrer"
					class="font-mono font-medium hover:underline"
					title="Open branch on GitHub"
				>
					{card.branch}
				</a>
			{:else}
				<span class="font-mono font-medium">{card.branch}</span>
			{/if}
			{#if !card.autoMerge}
				<Badge variant="outline" class="h-4 px-1 text-[0.55rem] uppercase tracking-wide">manual</Badge>
			{/if}
		</div>
		<div class="flex items-center gap-1.5">
			{#if argoCdUrl}
				<a
					href={argoCdUrl}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1 text-[0.65rem] text-primary hover:underline"
					title="Open ArgoCD application"
				>
					ArgoCD
					<ExternalLink class="size-2.5" />
				</a>
			{:else if argoCdBase}
				<a
					href={argoCdBase}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-primary"
					title="Open ArgoCD"
				>
					ArgoCD
					<ExternalLink class="size-2.5" />
				</a>
			{/if}
			{#if giteaHref}
				<a
					href={giteaHref}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-primary"
					title="Open branch on Gitea"
				>
					Gitea
					<ExternalLink class="size-2.5" />
				</a>
			{/if}
		</div>
	</header>

	<!-- Active section -->
	<div class="rounded-md border border-border/50 bg-background/40 p-2">
		<div class="mb-1 flex items-center gap-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
			Active
		</div>
		<div class="space-y-1.5">
			<CommitInfo commit={card.active.dry} label="dry" />
			<CommitInfo commit={card.active.hydrated} label="hyd" />
			<HealthSummary
				checks={card.active.commitStatuses}
				counts={card.active.checks}
				emptyLabel="no active checks"
			/>
		</div>
	</div>

	<!-- Proposed section (only when there is something pending) -->
	{#if card.proposed}
		<div class="rounded-md border border-amber-300/40 bg-amber-50/40 p-2 dark:border-amber-500/30 dark:bg-amber-950/20">
			<div class="mb-1 flex items-center justify-between gap-2">
				<span class="text-[0.6rem] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
					Proposed
				</span>
				{#if card.proposed.pullRequest}
					{@const id =
						card.proposed.pullRequest.metadata.labels?.[
							"promoter.argoproj.io/pull-request-id"
						] ?? card.proposed.pullRequest.status?.id ?? null}
					{#if id != null && prUrl}
						<a
							href={prUrl}
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center gap-0.5 text-[0.65rem] text-primary hover:underline"
							title="Open pull request"
						>
							<GitPullRequest class="size-2.5" />
							PR #{id}
							<ExternalLink class="size-2.5" />
						</a>
					{:else if id != null}
						<span class="inline-flex items-center gap-0.5 text-[0.65rem] text-muted-foreground">
							<GitPullRequest class="size-2.5" />
							PR #{id}
						</span>
					{/if}
				{/if}
			</div>
			<div class="space-y-1.5">
				<CommitInfo commit={card.proposed.dry} label="dry" />
				<CommitInfo commit={card.proposed.hydrated} label="hyd" />
				<HealthSummary
					checks={card.proposed.commitStatuses}
					counts={card.proposed.checks}
					defaultOpen
					emptyLabel="awaiting checks"
				/>
			</div>
		</div>
	{/if}
</section>
