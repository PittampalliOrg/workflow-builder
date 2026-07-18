<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { ExternalLink, GitPullRequest, Layers } from '@lucide/svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import { relativeTime } from '$lib/components/dev/preview-lifecycle';
	import { buildPrPreviewDedupeIndex, describeDedupeMatch } from '$lib/components/dev/preview-dedupe';
	import type {
		PreviewDriftEntry,
		PrPreviewListItem,
		VclusterPreviewSummary
	} from '$lib/types/dev-previews';

	// Fed by the hub page's getPrPreviews query. `enabled` reflects the
	// PR_PREVIEWS_ENABLED flag; off → an explanatory placeholder (no data).
	// `driftEntries` (getPreviewDriftOverview) + `previews` power the dedupe
	// badge: a PR whose code is already running in a retained/lifecycle preview
	// (promotion receipt by PR number or head SHA) is flagged before a duplicate
	// PR preview gets labeled up. Client-side join — no extra server reads.
	let {
		enabled = false,
		items = [],
		driftEntries = [],
		previews = []
	}: {
		enabled?: boolean;
		items?: PrPreviewListItem[];
		driftEntries?: PreviewDriftEntry[];
		previews?: VclusterPreviewSummary[];
	} = $props();

	const dedupeIndex = $derived(buildPrPreviewDedupeIndex(items, driftEntries, previews));

	function verifyLabel(state: string): string {
		if (state === 'completed') return 'verify passed';
		if (state === 'failed') return 'verify failed';
		if (state === 'started') return 'verifying…';
		return 'verify skipped';
	}
</script>

<section class="rounded-xl border bg-card p-4 space-y-3">
	<div class="flex items-start gap-3">
		<div class="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
			<GitPullRequest class="size-5 text-primary" />
		</div>
		<div class="min-w-0">
			<h2 class="text-base font-semibold">PR previews</h2>
			<p class="text-sm text-muted-foreground">
				Label a pull request <code class="text-xs">preview</code> to get an isolated vcluster running
				its head, with the touched services adopted in dev mode and (when enabled) a Playwright-critic
				verify pass.
			</p>
		</div>
	</div>

	{#if !enabled}
		<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
			PR previews are turned off. Set <code class="text-xs">PR_PREVIEWS_ENABLED=1</code> on the BFF to
			provision a preview for every <code class="text-xs">preview</code>-labeled PR.
		</div>
	{:else if items.length === 0}
		<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
			No PR previews yet. Add the <code class="text-xs">preview</code> label to a PR to spin one up.
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each items as pr (pr.prNumber)}
				<li class="px-3 py-2 space-y-1">
					<div class="flex items-center justify-between gap-3">
						<div class="flex items-center gap-2 min-w-0 flex-wrap">
							<a
								href={pr.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-medium hover:underline"
							>
								<GitPullRequest class="size-3.5" /> PR #{pr.prNumber}
							</a>
							<StatusPill status={pr.state} />
							{#if pr.verify}
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger>
											<StatusPill status={pr.verify.state} label={verifyLabel(pr.verify.state)} />
										</TooltipTrigger>
										<TooltipContent>
											<p class="max-w-[260px] text-xs">
												{pr.verify.reason ?? pr.verify.verdict ?? 'Playwright critic verify'}
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							{/if}
							{#if pr.headSha}
								<span class="font-mono text-[11px] text-muted-foreground">{pr.headSha.slice(0, 8)}</span>
							{/if}
							{#if dedupeIndex.get(pr.prNumber)}
								{@const dedupe = dedupeIndex.get(pr.prNumber)!}
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger>
											{#if dedupe.previewUrl}
												<a
													href={dedupe.previewUrl}
													target="_blank"
													rel="noopener noreferrer"
													class="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
												>
													<Layers class="size-3" aria-hidden="true" /> preview exists for this code
													<ExternalLink class="size-2.5" aria-hidden="true" />
												</a>
											{:else}
												<span
													class="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
												>
													<Layers class="size-3" aria-hidden="true" /> preview exists for this code
												</span>
											{/if}
										</TooltipTrigger>
										<TooltipContent>
											<p class="max-w-[280px] text-xs">{describeDedupeMatch(dedupe)}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							{/if}
						</div>
						<div class="flex items-center gap-2 shrink-0">
							{#if pr.url}
								<a
									href={pr.url}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
								>
									Open <ExternalLink class="size-3.5" />
								</a>
							{/if}
						</div>
					</div>

					<div class="flex items-center gap-x-2 gap-y-1 flex-wrap">
						{#each pr.services as svc (svc)}
							<Badge variant="outline" class="text-[10px] font-mono">{svc}</Badge>
						{/each}
						{#if relativeTime(pr.updatedAt)}
							<span class="text-[11px] text-muted-foreground">updated {relativeTime(pr.updatedAt)}</span>
						{/if}
					</div>

					{#if pr.error}
						<p class="text-[11px] text-destructive">{pr.error}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
