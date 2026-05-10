<script lang="ts">
	import { ExternalLink, GitBranch, GitMerge, RefreshCcw, Workflow } from "@lucide/svelte";

	import EnvironmentCard from "$lib/components/promoter/EnvironmentCard.svelte";
	import PipelineConnector from "$lib/components/promoter/PipelineConnector.svelte";
	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { buildPipelineView } from "$lib/promoter/pipeline-view";
	import { repoBrowseUrl } from "$lib/promoter/links";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	import type { GitopsPageLinks } from "../../../routes/(admin)/admin/gitops/+page.server";

	type Props = {
		promotions: PromotionStrategiesResponse;
		links: GitopsPageLinks;
		tektonBase: string | null;
		selectedStrategy: string | null;
		onSelectStrategy: (name: string | null) => void;
	};

	let { promotions, links, tektonBase: _tektonBase, selectedStrategy, onSelectStrategy }: Props = $props();

	const strategies = $derived(promotions.strategies);

	// Pick a default if the current selection is missing or empty.
	const activeName = $derived.by(() => {
		if (selectedStrategy && strategies.some((s) => s.metadata.name === selectedStrategy)) {
			return selectedStrategy;
		}
		return strategies[0]?.metadata.name ?? null;
	});

	const activeStrategy = $derived(
		activeName ? strategies.find((s) => s.metadata.name === activeName) ?? null : null,
	);

	const view = $derived(
		activeStrategy
			? buildPipelineView(activeStrategy, {
					pullRequests: promotions.pullRequests,
					changeTransferPolicies: promotions.changeTransferPolicies,
				})
			: null,
	);

	// Best-effort SCM browse URL for the strategy's gitRepositoryRef. Today the
	// hub aggregator doesn't dump the underlying GitRepository CR, so we infer
	// from any commit's `repoURL` in the status payload.
	const gitRepoUrl = $derived.by(() => {
		const env0 = activeStrategy?.status?.environments?.[0];
		const sha = env0?.active?.dry ?? env0?.active?.hydrated;
		return repoBrowseUrl(sha?.repoURL ?? links.stacksRepo);
	});

	const overallPhase = $derived(view?.overallPhase ?? "unknown");
</script>

<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
	{#if strategies.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<Workflow class="size-10 text-muted-foreground/50" />
			<div class="max-w-md">
				<p class="text-sm font-medium">No PromotionStrategy data available</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{promotions.error ??
						"The hub gitops-deployment-inventory has not yet dumped any PromotionStrategy resources. Land the stacks-repo Phase A change to populate this view."}
				</p>
			</div>
		</div>
	{:else}
		<div class="flex items-center justify-between gap-3 border-b px-5 py-2">
			<div class="flex items-center gap-2">
				<Workflow class="size-4 text-muted-foreground" />
				<label class="flex items-center gap-1.5 text-sm">
					<span class="text-xs text-muted-foreground">Strategy</span>
					<select
						class="rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
						value={activeName ?? ""}
						onchange={(e) => onSelectStrategy((e.currentTarget as HTMLSelectElement).value || null)}
					>
						{#each strategies as strategy (strategy.metadata.uid ?? strategy.metadata.name)}
							<option value={strategy.metadata.name}>
								{strategy.metadata.name}
								{strategy.metadata.namespace !== "argocd" ? ` (${strategy.metadata.namespace})` : ""}
							</option>
						{/each}
					</select>
				</label>
				<Badge
					variant={overallPhase === "failure"
						? "destructive"
						: overallPhase === "healthy"
							? "secondary"
							: "outline"}
					class="h-5 gap-1 px-1.5 text-[0.65rem]"
				>
					<StatusIcon
						phase={overallPhase === "healthy"
							? "success"
							: overallPhase === "failure"
								? "failure"
								: overallPhase === "pending"
									? "pending"
									: "unknown"}
						size="xs"
					/>
					{overallPhase}
				</Badge>
				{#if view?.gitRepositoryName}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
						<GitBranch class="size-3" />
						{view.gitRepositoryName}
					</Badge>
				{/if}
			</div>
			<div class="flex items-center gap-3 text-[0.65rem] text-muted-foreground">
				<span>
					{view?.envs.length ?? 0} env{(view?.envs.length ?? 0) === 1 ? "" : "s"}
				</span>
				{#if promotions.generatedAt}
					<span class="inline-flex items-center gap-1">
						<RefreshCcw class="size-3" />
						{new Date(promotions.generatedAt).toLocaleTimeString()}
					</span>
				{/if}
				{#if gitRepoUrl}
					<a
						href={gitRepoUrl}
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-0.5 text-primary hover:underline"
					>
						repo <ExternalLink class="size-2.5" />
					</a>
				{/if}
			</div>
		</div>

		{#if view && view.envs.length > 0}
			<div class="flex flex-1 min-h-0 items-stretch gap-1 overflow-x-auto p-5 snap-x">
				{#each view.envs as env, i (env.branch)}
					<div class="snap-start">
						<EnvironmentCard
							card={env}
							{gitRepoUrl}
							argoCdBase={links.argoCdBase}
						/>
					</div>
					{#if i < view.envs.length - 1}
						<PipelineConnector from={env} to={view.envs[i + 1]} />
					{/if}
				{/each}
			</div>
		{:else}
			<div class="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
				<div class="flex items-center gap-2">
					<GitMerge class="size-4" />
					This strategy has no environments yet.
				</div>
			</div>
		{/if}
	{/if}
</div>
