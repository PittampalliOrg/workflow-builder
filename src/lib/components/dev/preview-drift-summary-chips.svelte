<script lang="ts">
	import { GitCommit } from '@lucide/svelte';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		driftSummaryChips,
		shortSha,
		summarizeDriftOverview
	} from '$lib/components/dev/preview-drift-view';
	import type { PreviewDriftOverview } from '$lib/types/dev-previews';

	let {
		overview,
		loading = false,
		class: className = ''
	}: {
		overview: PreviewDriftOverview | null;
		loading?: boolean;
		class?: string;
	} = $props();

	const counts = $derived(summarizeDriftOverview(overview));
	const chips = $derived(driftSummaryChips(counts));
	const wbHead = $derived(shortSha(overview?.repoHeads.workflowBuilderMainSha ?? null));
	const stacksHead = $derived(shortSha(overview?.repoHeads.stacksMainSha ?? null));
</script>

{#if loading && !overview}
	<div class="flex items-center gap-1.5 {className}" aria-hidden="true">
		<Skeleton class="h-5 w-20 rounded-md" />
		<Skeleton class="h-5 w-24 rounded-md" />
	</div>
{:else if overview}
	<div
		class="flex flex-wrap items-center gap-1.5 {className}"
		role="group"
		aria-label="Fleet drift summary"
	>
		<TooltipProvider>
			{#each chips as chip (chip.status)}
				<Tooltip>
					<TooltipTrigger
						class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium tabular-nums {chip.badgeClass}"
						aria-label={`${chip.count} service${chip.count === 1 ? '' : 's'} ${chip.label.toLowerCase()}`}
					>
						<span class="size-1.5 rounded-full {chip.dotClass}" aria-hidden="true"></span>
						{chip.label}
						<span class="font-semibold">{chip.count}</span>
					</TooltipTrigger>
					<TooltipContent>
						<p class="max-w-[260px] text-xs text-muted-foreground">{chip.description}</p>
					</TooltipContent>
				</Tooltip>
			{/each}
			{#if chips.length === 0}
				<span class="text-[11px] text-muted-foreground">No running services to classify yet</span>
			{/if}
			{#if wbHead || stacksHead}
				<Tooltip>
					<TooltipTrigger
						class="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
						aria-label="Repository main heads"
					>
						<GitCommit class="size-3" aria-hidden="true" />
						{#if wbHead}<span>wb {wbHead}</span>{/if}
						{#if stacksHead}<span>stacks {stacksHead}</span>{/if}
					</TooltipTrigger>
					<TooltipContent>
						<p class="max-w-[260px] text-xs text-muted-foreground">
							Current main HEAD commits: workflow-builder {wbHead ?? 'unknown'} · stacks
							{stacksHead ?? 'unknown'}. Per-service verdicts compare running images against the
							dev release pins and these heads.
						</p>
					</TooltipContent>
				</Tooltip>
			{/if}
		</TooltipProvider>
	</div>
{/if}
